package lambdanet.train

import java.util.Calendar

import lambdanet._
import java.util.concurrent.ForkJoinPool

import botkop.numsca
import cats.Monoid
import funcdiff.{SimpleMath => SM}
import funcdiff._
import lambdanet.architecture._
import lambdanet.utils.{EventLogger, QLangAccuracy, QLangDisplay, ReportFinish}
import lambdanet.printWarning
import TrainingState._
import botkop.numsca.Tensor
import lambdanet.translation.PredicateGraph.{PNode, PType, ProjNode}
import lambdanet.translation.QLang.QModule
import org.nd4j.linalg.api.buffer.DataType

import scala.collection.parallel.ForkJoinTaskSupport
import scala.concurrent.{
  Await,
  ExecutionContext,
  ExecutionContextExecutorService,
  Future,
  TimeoutException,
}
import scala.language.reflectiveCalls

object TrainingLoop {
  var toyMod: Boolean = false

  def main(args: Array[String]): Unit = {
    Tensor.floatingDataType = DataType.DOUBLE
    run(
      maxTrainingEpochs = 5000,
      numOfThreads = readThreadNumber(),
    ).result()
  }

  case class run(
      maxTrainingEpochs: Int,
      numOfThreads: Int,
  ) {

//    Nd4j.setNumThreads(numOfThreads)
    printInfo(s"maxEpochs = $maxTrainingEpochs, threads: $numOfThreads")
    Timeouts.readFromFile()

    def result(): Unit = {
      val (state, logger) = loadTrainingState()
      val architecture = GruArchitecture(state.dimMessage, state.pc)
      val dataSet = DataSet.loadDataSet(taskSupport, architecture)
      trainOnProjects(dataSet, state, logger, architecture).result()
    }

    //noinspection TypeAnnotation
    case class trainOnProjects(
        dataSet: DataSet,
        trainingState: TrainingState,
        logger: EventLogger,
        architecture: NNArchitecture,
    ) {
      import dataSet._
      import trainingState._

      printResult(s"NN Architecture: ${architecture.arcName}")
      printResult(s"Single layer consists of: ${architecture.singleLayerModel}")

      def result(): Unit = {
        val saveInterval = if (toyMod) 100 else 10

        (trainingState.epoch0 + 1 to maxTrainingEpochs)
          .foreach { epoch =>
            announced(s"epoch $epoch") {
              handleExceptions(epoch) {
                trainStep(epoch)
                if (epoch % saveInterval == 0) {
                  saveTraining(epoch, s"epoch$epoch")
                }
                testStep(epoch)
              }
            }
          }

        saveTraining(maxTrainingEpochs, "finished")
        emailService.sendMail(emailService.userEmail)(
          s"TypingNet: Training finished on $machineName!",
          "Training finished!",
        )
      }

      val (machineName, emailService) = ReportFinish.readEmailInfo()
      private def handleExceptions(epoch: Int)(f: => Unit): Unit = {
        try f
        catch {
          case ex: Throwable =>
            val isTimeout = ex.isInstanceOf[TimeoutException]
            val errorName = if (isTimeout) "timeout" else "stopped"
            emailService.sendMail(emailService.userEmail)(
              s"TypingNet: $errorName on $machineName at epoch $epoch",
              s"Details:\n" + ex.getMessage,
            )
            if (isTimeout && Timeouts.restartOnTimeout) {
              println(
                "Timeout... training restarted (skip one training epoch)...",
              )
            } else {
              if (!ex.isInstanceOf[StopException]) {
                saveTraining(epoch, "error-save")
              }
              throw ex
            }
        }
      }

      val stepsPerEpoch = trainSet.length max testSet.length
      val random = new util.Random(2)

      def trainStep(epoch: Int): Unit = {
        val startTime = System.nanoTime()

        val stats = random.shuffle(trainSet).zipWithIndex.map {
          case (datum, i) =>
            import Console.{GREEN, BLUE}
            announced(
              s"$GREEN[epoch $epoch](progress: ${i + 1}/${trainSet.size})$BLUE train on $datum",
            ) {
              checkShouldStop(epoch)
              for {
                (loss, fwd, _) <- forward(datum).tap(
                  _.foreach(r => printResult(r._2)),
                )
                _ = checkShouldStop(epoch)
              } yield {
                checkShouldStop(epoch)
                def optimize(loss: CompNode) = {
                  val factor = fwd.loss.count.toDouble / avgAnnotations
                  optimizer.minimize(
                    loss * factor,
                    pc.allParams,
                    backPropInParallel =
                      Some(parallelCtx -> Timeouts.optimizationTimeout),
//                    gradientTransform = _.clipNorm(0.25 * factor),
                  )
                }

                val gradInfo = limitTimeOpt(
                  s"optimization: $datum",
                  Timeouts.optimizationTimeout,
                ) {
                  announced("optimization") {
                    val stats = DebugTime.logTime("optimization") {
                      optimize(loss)
                    }
                    calcGradInfo(stats)
                  }
                }.toVector

                DebugTime.logTime("GC") {
                  System.gc()
                }

                (fwd, gradInfo, datum)
              }
            }
        }

        import cats.implicits._
        val (fws, gs, data) = stats.flatMap(_.toVector).unzip3

        fws.combineAll.tap {
          case ForwardResult(loss, libAcc, projAcc, distanceAcc) =>
            logger.logScalar("loss", epoch, toAccuracyD(loss))
            logger.logScalar("libAcc", epoch, toAccuracy(libAcc))
            logger.logScalar("projAcc", epoch, toAccuracy(projAcc))
            logAccuracyDetails(data zip fws, epoch)
            val disMap = distanceAcc.toVector
              .sortBy(_._1)
              .map {
                case (k, counts) =>
                  val ks = if (k == Analysis.Inf) "Inf" else k.toString
                  ks -> toAccuracy(counts)
              }
            logger.logMap("distanceAcc", epoch, disMap)
            printResult("distance counts: " + distanceAcc.map {
              case (k, c) => k -> c.count
            })
        }

        val gradInfo = gs.combineAll
        gradInfo.unzip3.tap {
          case (grads, transformed, deltas) =>
            logger.logScalar("gradient", epoch, grads.sum)
            logger.logScalar("clippedGradient", epoch, transformed.sum)
            logger.logScalar("paramDelta", epoch, deltas.sum)
        }

        val timeInSec = (System.nanoTime() - startTime).toDouble / 1e9
        logger.logScalar("iter-time", epoch, timeInSec)

        println(DebugTime.show)
      }

      private def logAccuracyDetails(
          stats: Vector[(Datum, ForwardResult)],
          epoch: Int,
      ) = {
        import cats.implicits._
        val str = stats
          .map {
            case (d, f) =>
              val size = d.predictor.graph.predicates.size
              val acc = toAccuracy(
                f.libCorrect.combine(f.projCorrect),
              )
              val name = d.projectName
              s"""{$size, $acc, "$name"}"""
          }
          .mkString("{", ",", "}")
        logger.logString("accuracy-distr", epoch, str)
      }

      def testStep(epoch: Int): Unit =
        if ((epoch - 1) % 5 == 0) announced("test on dev set") {
          import cats.implicits._
          import ammonite.ops._
          val predictionDir = pwd / "predictions"
          rm(predictionDir)

          def printQSource(
              qModules: Vector[QModule],
              predictions: Map[ProjNode, PType],
              predictionSpace: PredictionSpace,
          ) = DebugTime.logTime("printQSource") {
            qModules.par.foreach { m =>
              QLangDisplay.renderModuleToDirectory(
                m,
                predictions.map { case (k, v) => k.n -> v },
                predictionSpace.allTypes,
              )(predictionDir)
            }
          }

          val (stat, fseAcc) = testSet.flatMap { datum =>
            checkShouldStop(epoch)
            announced(s"test on $datum") {
              forward(datum).map {
                case (_, fwd, pred) =>
                  printQSource(
                    datum.qModules,
                    pred,
                    datum.predictor.predictionSpace,
                  )

                  val fse = datum.fseAcc.countCorrect(pred)

                  (fwd, fse)
              }.toVector
            }
          }.combineAll

          import stat.{libCorrect, projCorrect}
          logger.logScalar("test-libAcc", epoch, toAccuracy(libCorrect))
          logger.logScalar("test-projAcc", epoch, toAccuracy(projCorrect))
          logger.logScalar("test-fseAcc", epoch, toAccuracy(fseAcc))
        }

      case class ForwardResult(
          loss: Counted[Double],
          libCorrect: Counted[LibCorrect],
          projCorrect: Counted[ProjCorrect],
          distCorrectMap: Map[Int, Counted[Correct]],
      ) {
        override def toString: String = {
          s"forward result: {loss: ${toAccuracyD(loss)}, " +
            s"lib acc: ${toAccuracy(libCorrect)} (${libCorrect.count} nodes), " +
            s"proj acc: ${toAccuracy(projCorrect)} (${projCorrect.count} nodes)}"
        }
      }

      def calcGradInfo(stats: Optimizer.OptimizeStats) = {
        def meanSquaredNorm(gs: Iterable[Gradient]) = {
          import numsca._
          import cats.implicits._
          val combined = gs.toVector.map { g =>
            val t = g.toTensor()
            Counted(t.elements, sum(square(t)))
          }.combineAll
          math.sqrt(combined.value / nonZero(combined.count))
        }

        val grads = meanSquaredNorm(stats.gradients.values)
        val transformed = meanSquaredNorm(stats.transformedGrads.values)
        val deltas = meanSquaredNorm(stats.deltas.values)
        (grads, transformed, deltas)
      }

      implicit val forwardResultMonoid: Monoid[ForwardResult] =
        new Monoid[ForwardResult] {
          import Counted.zero
          import cats.implicits._

          def empty: ForwardResult =
            ForwardResult(zero(0), zero(0), zero(0), Map())

          def combine(x: ForwardResult, y: ForwardResult): ForwardResult = {
            val z = ForwardResult.unapply(x).get |+| ForwardResult
              .unapply(y)
              .get
            (ForwardResult.apply _).tupled(z)
          }
        }

      val lossModel: LossModel = LossModel.EchoLoss
        .tap(m => printResult(s"loss model: ${m.name}"))

      private def forward(
          datum: Datum,
      ): Option[(Loss, ForwardResult, Map[ProjNode, PType])] =
        limitTimeOpt(s"forward: $datum", Timeouts.forwardTimeout) {
          import datum._

          val nodesToPredict = annotations.keys.toVector
          val predSpace = predictor.predictionSpace

          // the logits for very iterations
          val logitsVec = announced("run predictor") {
            predictor
              .run(architecture, nodesToPredict, iterationNum)
              .result
          }
          val logits = logitsVec.last

          val groundTruths = nodesToPredict.map(annotations)
          val targets = groundTruths.map(predSpace.indexOfType)
          val isFromLib = groundTruths.map(_.madeFromLibTypes)
          val nodeDistances = nodesToPredict.map(_.n.pipe(distanceToConsts))

          val (libCounts, projCounts, distanceCounts) =
            announced("compute training accuracy") {
              analyzeLogits(
                logits,
                targets,
                isFromLib,
                nodeDistances,
              )
            }

          val loss =
            lossModel.predictionLoss(
              predictor.parallelize(logitsVec),
              targets,
              predSpace.size,
            )

          val totalCount = libCounts.count + projCounts.count
          val fwd = ForwardResult(
            Counted(totalCount, loss.value.squeeze() * totalCount),
            libCounts,
            projCounts,
            distanceCounts,
          )

          val predictions: Map[ProjNode, PType] = {
            val predVec = numsca
              .argmaxAxis(logits.value, axis = 1)
              .data
              .map(d => predSpace.typeVector(d.toInt))
              .toVector
            nodesToPredict.zip(predVec).toMap
          }

          (loss, fwd, predictions)
        }

      @throws[TimeoutException]
      private def limitTime[A](timeLimit: Timeouts.Duration)(f: => A): A = {
        val exec = scala.concurrent.ExecutionContext.global
        Await.result(Future(f)(exec), timeLimit)
      }

      private def limitTimeOpt[A](
          name: String,
          timeLimit: Timeouts.Duration,
      )(f: => A): Option[A] = {
        try {
          Some(limitTime(timeLimit)(f))
        } catch {
          case _: TimeoutException =>
            val msg = s"$name exceeded time limit $timeLimit."
            printWarning(msg)
            emailService.atFirstTime {
              emailService.sendMail(emailService.userEmail)(
                s"TypingNet: timeout on $machineName during $name",
                s"Details:\n" + msg,
              )
            }
            None
        }
      }

      private def saveTraining(epoch: Int, dirName: String): Unit = {
        import ammonite.ops._

        announced(s"save training to $dirName") {
          val saveDir = pwd / "running-result" / "saved" / dirName
          if (!exists(saveDir)) {
            mkdir(saveDir)
          }
          val savePath = saveDir / "trainingState.serialized"
          TrainingState(epoch, dimMessage, iterationNum, optimizer, pc)
            .saveToFile(
              savePath,
            )
          val currentLogFile = pwd / "running-result" / "log.txt"
          if (exists(currentLogFile)) {
            cp.over(currentLogFile, saveDir / "log.txt")
          }
          val dateTime = Calendar.getInstance().getTime
          write.over(saveDir / "time.txt", dateTime.toString)
        }
      }

      @throws[StopException]
      private def checkShouldStop(epoch: Int): Unit = {
        if (TrainingControl.shouldStop(consumeFile = true)) {
          saveTraining(epoch, s"stopped-epoch$epoch")
          throw StopException("Stopped by 'stop.txt'.")
        }
      }

      private def analyzeLogits(
          logits: CompNode,
          targets: Vector[Int],
          targetFromLibrary: Vector[Boolean],
          nodeDistances: Vector[Int],
      ): (
          Counted[LibCorrect],
          Counted[ProjCorrect],
          Map[Int, Counted[Correct]],
      ) = {
        val predictions = numsca
          .argmaxAxis(logits.value, axis = 1)
          .data
          .map(_.toInt)
          .toVector
        val truthValues = predictions.zip(targets).map { case (x, y) => x == y }
        val zipped = targetFromLibrary.zip(truthValues)
        val libCorrect = zipped.collect {
          case (true, true) => ()
        }.length
        val projCorrect = zipped.collect {
          case (false, true) => ()
        }.length
        val libCounts = Counted(targetFromLibrary.count(identity), libCorrect)
        val projCounts = Counted(targetFromLibrary.count(!_), projCorrect)

        val distMap = nodeDistances
          .zip(truthValues)
          .groupBy(_._1)
          .mapValuesNow { vec =>
            Counted(vec.length, vec.count(_._2))
          }

        (libCounts, projCounts, distMap)
      }

      private val avgAnnotations =
        SM.mean(trainSet.map(_.annotations.size.toDouble))
    }

    val taskSupport: Option[ForkJoinTaskSupport] =
      if (numOfThreads == 1) None
      else Some(new ForkJoinTaskSupport(new ForkJoinPool(numOfThreads)))
    val parallelCtx: ExecutionContextExecutorService = {
      import ExecutionContext.fromExecutorService
      fromExecutorService(new ForkJoinPool(numOfThreads))
    }
  }

  private def readThreadNumber() = {
    import ammonite.ops._
    val f = pwd / "configs" / "threads.txt"
    if (exists(f)) {
      read(f).trim.toInt
    } else {
      Runtime.getRuntime.availableProcessors() / 2
    }
  }

}
