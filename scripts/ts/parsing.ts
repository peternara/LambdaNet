import * as ts from "typescript";
import {SyntaxKind} from "typescript";


export class GModule {
  constructor(public name: string, public stmts: GStmt[]) {
  }
}

export function mustExist<T>(v?: T, msg?: string): T {
  if (!v) {
    if (msg) {
      throw new Error("should not be " + v + "! Message: " + msg);
    } else {
      throw new Error("should not be " + v + "!");
    }
  }
  return v;
}

// ASTs
type GMark = GType | null;


type GType = TVar | AnyType | FuncType | ObjectType

class TVar {
  public readonly category = "TVar";

  constructor(public name: string) {
    mustExist(name);
  }
}

class AnyType {
  public readonly category = "AnyType";
  public readonly name = "any";

  private constructor() {
  }

  static instance = new AnyType();
}

class FuncType {
  public readonly category = "FuncType";

  constructor(public args: GType[], public to: GType) {
  }
}

class ObjectType {
  public readonly category = "ObjectType";

  constructor(public fields: NamedValue<GType>[]) {
  }
}

export const anyType = AnyType.instance;

let basicTypes = new Set<SyntaxKind>();
basicTypes.add(SyntaxKind.BooleanKeyword);
basicTypes.add(SyntaxKind.NumberKeyword);
basicTypes.add(SyntaxKind.StringKeyword);
basicTypes.add(SyntaxKind.SymbolKeyword);
basicTypes.add(SyntaxKind.EnumKeyword);
basicTypes.add(SyntaxKind.VoidKeyword);
basicTypes.add(SyntaxKind.ObjectKeyword);

let ignoredTypes = new Set<SyntaxKind>();
ignoredTypes.add(SyntaxKind.MappedType);
ignoredTypes.add(SyntaxKind.ConditionalType);
ignoredTypes.add(SyntaxKind.ThisType);
ignoredTypes.add(SyntaxKind.UnknownKeyword);
ignoredTypes.add(SyntaxKind.IndexedAccessType);
ignoredTypes.add(SyntaxKind.UndefinedKeyword);
ignoredTypes.add(SyntaxKind.NeverKeyword);

function parseTVars(n: { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }): string[] {
  return n.typeParameters ? n.typeParameters.map(p => p.name.text) : [];
}

/** Replace all occurrences of type variables with any  */
function eliminateTypeVars(ty: GType, tVars: string[]): GType {
  switch (ty.category) {
    case "TVar":
      if (tVars.includes(ty.name)) {
        return anyType;
      } else {
        return ty;
      }
    case "FuncType": {
      let newFrom = ty.args.map(t => eliminateTypeVars(t, tVars));
      let newTo = eliminateTypeVars(ty.to, tVars);
      return new FuncType(newFrom, newTo);
    }
    case "ObjectType": {
      let nf = ty.fields.map(nv => new NamedValue(nv.name, eliminateTypeVars(nv.value, tVars)));
      return new ObjectType(nf);
    }
    case "AnyType":
      return ty;
    default:
      throw new Error("Unknown category: " + JSON.stringify(ty));
  }
}

function parseSignatureType(sig: ts.SignatureDeclarationBase) {
  let tVars = parseTVars(sig);
  let argTypes = sig.parameters.map(p =>
    eliminateTypeVars(parseType(mustExist(p.type)), tVars));
  let retType = sig.type ? parseType(sig.type) : new TVar("void");
  return new FuncType(argTypes, retType);
}

function parseTypeMembers(members: ts.NamedDeclaration[]): NamedValue<GType>[] {
  let fields: NamedValue<GType>[] = [];
  members.forEach(
    x => {
      if (x.name) {
        if (SyntaxKind.PropertyDeclaration == x.kind || SyntaxKind.PropertySignature == x.kind) {
          let pT = (x as any).type;
          fields.push(new NamedValue(x.name.getText(), pT ? parseType(pT) : anyType));
        } else if (SyntaxKind.MethodSignature == x.kind || SyntaxKind.MethodDeclaration == x.kind) {
          fields.push(new NamedValue(x.name.getText(), parseSignatureType(x as ts.MethodSignature)));
        } else {
          throw new Error("Unknown type member kind: " + SyntaxKind[x.kind]);
        }
      } else if ([SyntaxKind.IndexSignature, SyntaxKind.CallSignature,
        SyntaxKind.ConstructSignature].includes(x.kind)) {
        let sig = x as ts.IndexSignatureDeclaration | ts.CallSignatureDeclaration | ts.ConstructSignatureDeclaration;
        let methodName = x.kind == SyntaxKind.IndexSignature ? "access"
          : (x.kind == SyntaxKind.ConstructSignature ? "CONSTRUCTOR" : "call");
        fields.push(new NamedValue(methodName, parseSignatureType(sig)));
      } else {
        throw new Error("Unknown type element: " + ts.SyntaxKind[x.kind]);
      }
      // else throw new Error("members without a name: " + node.getText()); todo: uncomment and handle other cases
    }
  );
  return fields;
}

function parseType(node: ts.TypeNode): GType {
  if (node.kind == SyntaxKind.AnyKeyword) {
    return anyType;
  } else if (ts.isTypeReferenceNode(node)) {
    let n = node as ts.TypeReferenceNode;
    return new TVar(n.typeName.getText());
  } else if (basicTypes.has(node.kind)) {
    return new TVar(node.getText());
  } else if (node.kind == SyntaxKind.ArrayType) {
    return new TVar("Array");
  } else if (node.kind == SyntaxKind.FunctionType || node.kind == SyntaxKind.ConstructorType) {
    let n = node as ts.FunctionOrConstructorTypeNode;

    let ret: GType = parseType(n.type);
    let args: GType[] = n.parameters.map(p => {
      return parseType(mustExist(p.type));
    });

    return new FuncType(args, ret);
  } else if (node.kind == SyntaxKind.TypeLiteral) {
    let n = node as ts.TypeLiteralNode;
    let members = parseTypeMembers(n.members as any);
    return new ObjectType(members);
  } else if (node.kind == SyntaxKind.UnionType) {
    let n = node as ts.UnionTypeNode;
    if (n.types.length == 2) {
      let second = n.types[1].getText();
      if (second == "null" || second == "undefined") {
        return parseType(n.types[0]);
      } else {
        return anyType;
      }
    }
    return anyType;
  } else if (ignoredTypes.has(node.kind)) {
    return anyType;
  } else if (node.kind == SyntaxKind.LiteralType) {
    let n = node as ts.LiteralTypeNode;
    switch (n.literal.kind) {
      case SyntaxKind.StringLiteral:
        return new TVar("string");
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
        return new TVar("boolean");
      case SyntaxKind.NumericLiteral:
        return new TVar("number");
      default:
        return anyType; //todo: support more literal types
    }
  } else if (node.kind == SyntaxKind.IntersectionType) {
    return anyType;
  } else if (node.kind == SyntaxKind.ParenthesizedType) {
    let n = node as ts.ParenthesizedTypeNode;
    return parseType(n.type);
  } else if (node.kind == SyntaxKind.FirstTypeNode) {
    return new TVar("boolean");
  } else if (node.kind == SyntaxKind.TupleType) {
    return new TVar("Array");
  } else if (node.kind == SyntaxKind.TypeQuery) {
    return anyType; // fixme: handle type query
  } else {
    throw new Error("Unknown Type Kind: " + ts.SyntaxKind[node.kind]);
  }
}

export function parseMark(node?: ts.TypeNode): GMark {
  if (!node) {
    return null;
  } else {
    return parseType(node);
  }
}


class NamedValue<V> {
  constructor(public name: string, public value: V) {
  }
}

interface GExpr {
  category: string
}

class Var implements GExpr {
  category: string = "Var";

  constructor(public name: string) {
    mustExist(name);
  }
}

class Const implements GExpr {
  category: string = "Const";

  constructor(public value: string, public ty: GType, public line: number) {
    mustExist(value);
  }
}

class FuncCall implements GExpr {
  category: string = "FuncCall";

  constructor(public f: GExpr, public args: GExpr[]) {
  }
}

class ObjLiteral implements GExpr {
  category: string = "ObjLiteral";

  constructor(public fields: NamedValue<GExpr>[]) {
  }
}

class Access implements GExpr {
  category: string = "Access";

  constructor(public expr: GExpr, public field: string) {
    mustExist(field);
  }
}

class IfExpr implements GExpr {
  category: string = "IfExpr";

  constructor(public cond: GExpr, public e1: GExpr, public e2: GExpr) {
  }
}


export interface GStmt {
  category: string
}

class VarDef implements GStmt {
  category: string = "VarDef";

  constructor(public x: string, public mark: GMark,
              public init: GExpr, public isConst: boolean, public modifiers: string[]) {
    mustExist(x);
  }
}

class AssignStmt implements GStmt {
  category: string = "AssignStmt";

  constructor(public lhs: GExpr, public rhs: GExpr) {
  }
}

class ExprStmt implements GStmt {
  category: string = "ExprStmt";

  constructor(public expr: GExpr, public isReturn: boolean) {
  }
}

class IfStmt implements GStmt {
  category: string = "IfStmt";

  constructor(public cond: GExpr, public branch1: GStmt, public branch2: GStmt) {
  }
}

class WhileStmt implements GStmt {
  category: string = "WhileStmt";

  constructor(public cond: GExpr, public body: GStmt) {
  }
}

class ImportStmt implements GStmt {
  category: string = "ImportStmt";

  constructor(public text: string) {
    mustExist(text);
  }
}

class ExportStmt implements GStmt {
  category: string = "ExportStmt";

  constructor(public text: string) {
    mustExist(text);
  }
}

class TypeAliasStmt implements GStmt {
  category: string = "TypeAliasStmt";

  constructor(public name: string, public tyVars: string[], public type: GType, public modifiers: string[]) {
    mustExist(name);
    mustExist(tyVars);
    mustExist(type);
    mustExist(modifiers);
  }
}

class CommentStmt implements GStmt {
  category: string = "CommentStmt";

  constructor(public text: string) {
    mustExist(text);
  }
}

class BlockStmt implements GStmt {
  category: string = "BlockStmt";

  constructor(public stmts: GStmt[]) {
  }
}

class FuncDef implements GStmt {
  category: string = "FuncDef";

  constructor(public name: string, public args: NamedValue<GMark>[], public returnType: GMark,
              public body: GStmt, public modifiers: string[], public tyVars: string[]) {
    mustExist(name);
    if ((name == "Constructor") && returnType && (returnType as TVar).name != 'void') {
      throw new Error("Wrong return type for constructor. Got: " + returnType);
    }
  }
}

class Constructor extends FuncDef {
  constructor(name: string, args: NamedValue<GMark>[], returnType: GMark,
              body: GStmt, modifiers: string[], tyVars: string[],
              public publicVars: string[]) {
    super(name, args, returnType, body, modifiers, tyVars);
    mustExist(publicVars);
  }
}

class ClassDef implements GStmt {
  category: string = "ClassDef";

  constructor(public name: string, public constructor: FuncDef | null,
              public vars: [NamedValue<GMark>, boolean][],
              public funcDefs: [FuncDef, boolean][],
              public superType: string | null, public modifiers: string[],
              public tyVars: string[]) {
  }
}

function tryFullyQualifiedName(node: ts.Node, checker: ts.TypeChecker): string {
  // let symbol = checker.getSymbolAtLocation(node);
  // let name: string = symbol ? checker.getFullyQualifiedName(symbol) : (<any>node)["text"]; fixme: not working
  let name = (<any>node).text;
  mustExist(name);
  return name;
}

type SupportedExpression =
  ts.Identifier |
  ts.ThisExpression |
  ts.SuperExpression |
  ts.CallExpression |
  ts.NewExpression |
  ts.ObjectLiteralExpression |
  ts.PropertyAccessExpression |
  ts.ElementAccessExpression |
  ts.ConditionalExpression |
  ts.ParenthesizedExpression |
  LiteralExpression |
  ts.BinaryExpression |
  ts.PrefixUnaryExpression | ts.PostfixUnaryExpression |
  ts.FunctionExpression | ts.ArrowFunction |
  SpecialExpressions


type LiteralExpression =
  ts.NumericLiteral |
  ts.StringLiteral |
  ts.RegularExpressionLiteral |
  ts.BooleanLiteral |
  ts.NullLiteral |
  ts.VoidExpression |
  ts.ArrayLiteralExpression |
  ts.NoSubstitutionTemplateLiteral

type SpecialExpressions =
  ts.SpreadElement |
  ts.TypeOfExpression |
  ts.TemplateExpression |
  ts.DeleteExpression |
  ts.YieldExpression |
  ts.AsExpression |
  ts.TypeAssertion

export function parseExpr(node: ts.Expression, checker: ts.TypeChecker,
                          allocateLambda: (f: ts.FunctionLikeDeclaration) => Var): GExpr {

  function rec(node: ts.Expression): GExpr {
    const n = node as SupportedExpression;
    mustExist(n);

    switch (n.kind) {
      case SyntaxKind.Identifier: {
        let name = n.text;
        return new Var(name);
      }
      case SyntaxKind.ThisKeyword:
        return SpecialVars.THIS;
      case SyntaxKind.SuperKeyword:
        return SpecialVars.SUPER;
      case SyntaxKind.CallExpression: {
        let f = rec(n.expression);
        let args = n.arguments.map(rec);
        return new FuncCall(f, args);
      }
      case SyntaxKind.NewExpression: {
        let args = n.arguments ? n.arguments.map(rec) : [];
        let f = new Access(rec(n.expression), "CONSTRUCTOR");
        return new FuncCall(f, args);
      }
      case SyntaxKind.ObjectLiteralExpression: {
        const fields = flatMap(n.properties, (p: ts.ObjectLiteralElementLike) => {
          if (p.kind == SyntaxKind.PropertyAssignment) {
            return [parseObjectLiteralElementLike(p)];
          } else {
            return []; //todo: other cases
          }
        });
        return new ObjLiteral(fields);
      }
      case SyntaxKind.PropertyAccessExpression: {
        let lhs = rec(n.expression);
        return new Access(lhs, n.name.text);
      }
      case ts.SyntaxKind.ElementAccessExpression: {
        let thing = rec(n.expression);
        let index = rec(n.argumentExpression);
        return new FuncCall(new Access(thing, "access"), [index]);
      }
      case ts.SyntaxKind.ConditionalExpression: {
        let cond = rec(n.condition);
        let e1 = rec(n.whenTrue);
        let e2 = rec(n.whenFalse);
        return new IfExpr(cond, e1, e2);
      }
      case ts.SyntaxKind.ParenthesizedExpression: {
        return rec(n.expression);
      }

      // constants
      case SyntaxKind.NumericLiteral:
        return constExpr("number");
      case SyntaxKind.StringLiteral:
        return constExpr("string");
      case SyntaxKind.RegularExpressionLiteral:
        return constExpr("RegExpr");
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
        return constExpr("bool");
      case SyntaxKind.NullKeyword:
        return constExpr(anyType.name, "null");
      case SyntaxKind.VoidExpression: {
        return constExpr(anyType.name, "void");
      }

      case SyntaxKind.ArrayLiteralExpression:
        return constExpr("array"); //todo: might need to distinguish array types

      // operators
      case ts.SyntaxKind.BinaryExpression: {
        let l = rec(n.left);
        let r = rec(n.right);
        let opp = n.operatorToken.kind;

        return new FuncCall(new Access(l, ts.SyntaxKind[opp]), [r]);
      }
      case SyntaxKind.PrefixUnaryExpression:
      case SyntaxKind.PostfixUnaryExpression: {
        let opName = ts.SyntaxKind[n["operator"]];
        let fixity = (node.kind == SyntaxKind.PrefixUnaryExpression) ? "" : "POST_";
        let arg = rec(n["operand"]);
        return new FuncCall(new Var(fixity + opName), [arg]);
      }
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionExpression: {
        return allocateLambda(n);
      }

      // Special treatments:
      case SyntaxKind.SpreadElement: {
        return new FuncCall(SpecialVars.spread, [rec(n.expression)]);
      }
      case SyntaxKind.TypeOfExpression: {
        return new FuncCall(SpecialVars.typeOf, [rec(n.expression)]);
      }
      case SyntaxKind.NoSubstitutionTemplateLiteral:
      case SyntaxKind.TemplateExpression: {
        return constExpr("string");
      }
      case SyntaxKind.DeleteExpression: {
        return new FuncCall(SpecialVars.DELETE, [rec(n.expression)]);
      }
      case SyntaxKind.YieldExpression: {
        return new FuncCall(SpecialVars.YIELD, [rec(mustExist(n.expression))]);
      }
      // type assertions are ignored
      case SyntaxKind.AsExpression:
      case SyntaxKind.TypeAssertionExpression: {
        return rec(n.expression);
      }

      default: {
        throw new Error("Unknown expression category: " + ts.SyntaxKind[node.kind]
          + ". Text: " + node.getText());
      }
    }

    function constExpr(typeName: string, value?: string): Const {
      // let v = (<ts.LiteralLikeNode>node).text;
      const v = value ? value: "???";
      return new Const(v, new TVar(typeName), getLineNumber(n));
    }

    function parseObjectLiteralElementLike(p: ts.PropertyAssignment): NamedValue<GExpr> {
      //todo: properly handle other cases like accessors
      let a = (<ts.PropertyAssignment>p);
      let fieldName = (<ts.StringLiteral>a.name).text;
      return new NamedValue<GExpr>(fieldName,
        a.initializer ? rec(a.initializer) : new Var(fieldName));
    }
  }

  return rec(node);
}

export const undefinedValue = new Const("undefined", anyType, -1);

export class StmtParser {
  public nLambda: [number] = [0];

  parseStmt(node: ts.Node, checker: ts.TypeChecker): GStmt[] {
    let getNLambda = this.nLambda;

    class StmtsHolder {
      constructor(public stmts: GStmt[]) {
      }
    }

    class ExprProcessor {
      lambdaDefs: FuncDef[] = [];

      processExpr(e: ts.Expression): GExpr {
        let lambdas = this.lambdaDefs;

        function allocateLambda(f: ts.FunctionLikeDeclaration): Var {
          let n0 = (f as ts.FunctionExpression).name;

          let name: string;
          if (n0) {
            name = n0.getText();
          } else {
            name = "$Lambda" + getNLambda[0];
            getNLambda[0] += 1;
          }
          lambdas.push(parseFunction(name, f, []));
          return new Var(name);
        }

        return parseExpr(e, checker, allocateLambda);
      }

      alongWith(...stmts: GStmt[]): StmtsHolder {
        return new StmtsHolder((<GStmt[]>this.lambdaDefs).concat(stmts));
      }

      alongWithMany(stmts: GStmt[]): StmtsHolder {
        return new StmtsHolder((<GStmt[]>this.lambdaDefs).concat(stmts));
      }
    }

    /**
     * returns the parsed FuncDef along with arguments that are marked
     * with 'public' (for constructors)
     */
    function parseFunction(name: string, n: ts.FunctionLikeDeclaration, modifiers: string[]): FuncDef {
      const isConstructor = ts.isConstructorDeclaration(n);
      let retType = isConstructor ? new TVar("void") :
        parseMark(n.type);

      let publicArgs: string[] = [];

      let args = n.parameters.map(p => {
        let name = (<ts.Identifier>p.name).text;
        if (parseModifiers(p.modifiers).includes("public")) {
          publicArgs.push(name);
        }
        return new NamedValue(name, parseMark(p.type));
      });


      let body: StmtsHolder;
      if (n.body) {
        if (n.body.kind == SyntaxKind.Block) {
          body = rec(n.body as ts.Statement);
        } else {
          let ep = new ExprProcessor();
          // try to parse the body as a ConciseFunction body
          body = ep.alongWith(new ExprStmt(ep.processExpr((n.body as ts.Expression)), true));
        }
      } else {
        body = new ExprProcessor().alongWithMany([]);
      }

      let type_params = n.typeParameters;
      let t_vars: string[];
      if (type_params) {
        t_vars = type_params.map(n => n.name.text);
      } else {
        t_vars = [];
      }

      return isConstructor ?
        new Constructor(name, args, retType, flattenBlock(body.stmts), modifiers, t_vars, publicArgs) :
        new FuncDef(name, args, retType, flattenBlock(body.stmts), modifiers, t_vars);
    }


    function rec(node: ts.Node): StmtsHolder {
      mustExist(node);

      let EP = new ExprProcessor();

      function parseVarDecList(node: ts.VariableDeclarationList, modifiers: string[]): VarDef[] {

        return forNode(node, () => {
          let isConst = (node.flags & ts.NodeFlags.Const) != 0;

          function parseBinding(x: ts.BindingElement | ts.VariableDeclaration, rhs?: GExpr): VarDef[] {
            let initExpr = rhs ? rhs : (x.initializer ? EP.processExpr(x.initializer) : undefinedValue);
            const lhs: ts.BindingName = x.name;
            switch (lhs.kind) {
              case SyntaxKind.Identifier:
                return [new VarDef(
                  (<ts.Identifier>lhs).text,
                  parseMark((<any>x).type),
                  initExpr,
                  isConst,
                  modifiers)];
              case SyntaxKind.ObjectBindingPattern:
                return flatMap((lhs as ts.ObjectBindingPattern).elements, (e: ts.BindingElement) => {
                  let access = new Access(initExpr, (e.name as ts.Identifier).text);
                  return parseBinding(e, access);
                });
              case SyntaxKind.ArrayBindingPattern: {
                let arrayAccessed = new FuncCall(SpecialVars.ArrayAccess, [initExpr]);
                return flatMap(lhs.elements, (e: ts.ArrayBindingElement) => {
                  if (e.kind == SyntaxKind.OmittedExpression) {
                    return [];
                  } else {
                    return parseBinding(e as ts.BindingElement, arrayAccessed);
                  }
                });
              }
              default:
                throw new Error("Unsupported binding pattern " + SyntaxKind[(lhs as any).kind] + ": " + x.getText());
            }
          }

          let dec = node.declarations;
          return flatMap(dec, (x: ts.VariableDeclaration) => parseBinding(x, undefined));
        });
      }

      function isStatic(n: ts.ClassElement): boolean {
        return parseModifiers(n.modifiers).includes("static");
      }

      switch (node.kind) {
        case SyntaxKind.ThrowStatement:
        case SyntaxKind.ExpressionStatement: {
          let n = <ts.ExpressionStatement>node;
          if (n.expression.kind == SyntaxKind.BinaryExpression) {
            let e = n.expression as ts.BinaryExpression;
            if (e.operatorToken.kind == ts.SyntaxKind.FirstAssignment) {
              let l = EP.processExpr(e.left);
              let r = EP.processExpr(e.right);
              return EP.alongWith(new AssignStmt(l, r));
            }
          }
          let shouldReturn = n.expression.kind == SyntaxKind.YieldExpression;
          return EP.alongWith(new ExprStmt(EP.processExpr(n.expression), shouldReturn));
        }
        case SyntaxKind.ReturnStatement: {
          let n = <ts.ReturnStatement>node;
          return n.expression ?
            EP.alongWith(new ExprStmt(EP.processExpr(n.expression), true))
            : EP.alongWith(new CommentStmt("return;"));
        }
        case SyntaxKind.VariableStatement: {
          let n = node as ts.VariableStatement;
          let ms = parseModifiers(n.modifiers);
          let list = n.declarationList;
          return EP.alongWithMany(parseVarDecList(list, ms));
        }
        case SyntaxKind.IfStatement: {
          let n = node as ts.IfStatement;
          let cond = EP.processExpr(n.expression);
          let then = flattenBlock(rec(n.thenStatement).stmts);
          let otherwise: GStmt[];
          if (n.elseStatement == undefined) {
            otherwise = [new BlockStmt([])];
          } else {
            otherwise = rec(n.elseStatement).stmts;
          }
          return EP.alongWith(new IfStmt(cond, then, flattenBlock(otherwise)));
        }
        case SyntaxKind.WhileStatement: {
          let n = node as ts.WhileStatement;
          let cond = EP.processExpr(n.expression);
          let body = flattenBlock(rec(n.statement).stmts);
          return EP.alongWith(new WhileStmt(cond, body));
        }
        case SyntaxKind.Block: {
          let n = node as ts.Block;
          let stmts = flatMap(n.statements, (x: ts.Node) => rec(x).stmts);
          return EP.alongWith(new BlockStmt(stmts));
        }
        case ts.SyntaxKind.ForStatement: {
          let n = node as ts.ForStatement;
          let cond = mustExist(n.condition);
          let init = n.initializer;
          let outerBlock = new BlockStmt([]);

          if (init && ts.isVariableDeclarationList(init)) {
            outerBlock.stmts = parseVarDecList(init, []);
          } else if (init) {
            outerBlock.stmts.push(new ExprStmt(EP.processExpr(init as ts.Expression), false));
          }

          let incr = n.incrementor ? [new ExprStmt(EP.processExpr(n.incrementor), false)] : [];
          let bodyStmts: GStmt[] = rec(n.statement).stmts.concat(incr);

          outerBlock.stmts.push(new WhileStmt(
            EP.processExpr(cond),
            flattenBlock(bodyStmts)
          ));
          return EP.alongWith(outerBlock);
        }
        case SyntaxKind.FunctionDeclaration:
        case SyntaxKind.MethodDeclaration:
        case SyntaxKind.GetAccessor:
        case SyntaxKind.SetAccessor:
        case SyntaxKind.Constructor: {
          let name = (node.kind == SyntaxKind.Constructor) ? "Constructor" :
            tryFullyQualifiedName((node as any).name, checker);
          let n = <ts.FunctionLikeDeclaration>node;
          let modifiers = parseModifiers(n.modifiers);
          if (node.kind == SyntaxKind.SetAccessor) {
            modifiers.push("set");
          } else if (node.kind == SyntaxKind.GetAccessor) {
            modifiers.push("get");
          }
          return EP.alongWith(parseFunction(name, n, modifiers));
        }

        case SyntaxKind.ClassDeclaration: {
          let n = node as ts.ClassDeclaration;

          let name = tryFullyQualifiedName(mustExist(n.name), checker);

          let superType: string | null = null;
          if (n.heritageClauses != undefined) {
            let clauses = n.heritageClauses;
            for (const c of clauses) {
              if (c.token == ts.SyntaxKind.ExtendsKeyword) {
                superType = c.types[0].expression.getText(); //todo: handle more cases
                // superType = mustExist((c.types[0].expression as any)["name"]) as string;
              }
            }
          }

          let vars: [NamedValue<GMark>, boolean][] = [];
          let funcDefs: [FuncDef, boolean][] = [];
          let constructor: Constructor | null = null;

          // let isAbstract = n.modifiers && n.modifiers.map(x => x.kind).includes(SyntaxKind.AbstractKeyword);

          for (const v of n.members) {
            const staticQ = isStatic(v);
            if (ts.isPropertyDeclaration(v)) {
              let v1 = v as ts.PropertyDeclaration;
              vars.push([new NamedValue(getPropertyName(v1.name), parseMark(v1.type)), staticQ]);
            } else if (ts.isMethodDeclaration(v) || ts.isAccessor(v)) {
              funcDefs.push([getSingleton(rec(v).stmts) as FuncDef, staticQ]);
            } else if (ts.isConstructorDeclaration(v)) {
              const c = getSingleton(rec(v).stmts) as Constructor;
              c.args
                .filter(v => c.publicVars.includes(v.name))
                .forEach(p => vars.push([p, false]));
              constructor = c;
            } else if (ts.isSemicolonClassElement(v)) {
              // ignore
            } else {
              throw new Error("Unknown statements in class definitions: " + SyntaxKind[v.kind]);
            }
          }

          let classModifiers = parseModifiers(n.modifiers);

          let tVars = parseTVars(n);

          let classStmt = new ClassDef(name, constructor, vars, funcDefs,
            superType, classModifiers, tVars);

          return EP.alongWith(classStmt);
        }
        case SyntaxKind.SwitchStatement: {
          let n = node as ts.SwitchStatement;

          let switchCall = new FuncCall(SpecialVars.SWITCH, [EP.processExpr(n.expression)]);

          let clauses = flatMap(
            n.caseBlock.clauses,
            (c: ts.CaseOrDefaultClause) => {
              let body = flatMap(c.statements, (s: ts.Statement) => rec(s).stmts);
              switch (c.kind) {
                case SyntaxKind.CaseClause:
                  let f = new FuncCall(SpecialVars.CASE, [EP.processExpr((c as ts.CaseClause).expression)]);
                  let all = [new ExprStmt(f, false) as GStmt].concat(body);
                  return EP.alongWithMany(all).stmts;
                case SyntaxKind.DefaultClause:
                  return EP.alongWithMany(body).stmts;
              }
            });
          return EP.alongWithMany([new ExprStmt(switchCall, false) as GStmt].concat(clauses));
        }

        case SyntaxKind.ImportDeclaration: {
          let n = node as ts.ImportDeclaration;
          n.importClause; //todo
          return EP.alongWith(new ImportStmt(node.getText()));
        }
        case SyntaxKind.ExportAssignment:
        case SyntaxKind.ExportDeclaration:
          return EP.alongWith(new ExportStmt(node.getText()));
        case SyntaxKind.EnumDeclaration: {
          let n = node as ts.EnumDeclaration;
          let vars = n.members.map(member => {
            let vName = member.name.getText();
            return new NamedValue(vName,
              new Const("ENUM", new TVar("number"), getLineNumber(n)));
          });
          let rhs = new ObjLiteral(vars);

          return EP.alongWith(new VarDef(n.name.text, null, rhs,
            true, parseModifiers(n.modifiers)));
        }
        case SyntaxKind.InterfaceDeclaration: {
          let n = node as ts.InterfaceDeclaration;
          let tVars = parseTVars(n);
          let members = parseTypeMembers(n.members as any);
          let objT = new ObjectType(members); //todo: handle inheritance
          return EP.alongWith(
            new TypeAliasStmt(n.name.text, tVars, objT, parseModifiers(n.modifiers)));
        }
        case SyntaxKind.TypeAliasDeclaration: {
          let n = node as ts.TypeAliasDeclaration;
          let tVars = parseTVars(n);
          return EP.alongWith(
            new TypeAliasStmt(n.name.text, tVars, parseType(n.type), parseModifiers(n.modifiers)));
        }
        case SyntaxKind.TryStatement: {
          let n = node as ts.TryStatement;

          let tryPart = rec(n.tryBlock).stmts;
          let finallyPart = n.finallyBlock ? rec(n.finallyBlock).stmts : [];
          return EP.alongWithMany(tryPart.concat(finallyPart));
        }


        //todo: support these
        case SyntaxKind.ModuleDeclaration:
        case SyntaxKind.ForOfStatement:
        case SyntaxKind.ForInStatement:

        // ignored statements:
        case SyntaxKind.ImportEqualsDeclaration: //fixme: may need to handle this
        case SyntaxKind.BreakStatement:
        case SyntaxKind.ContinueStatement:
          return EP.alongWith(new CommentStmt(node.getText()));
        case SyntaxKind.EmptyStatement:
          return EP.alongWithMany([]);

        default:
          throw new Error("Unknown stmt category: " + ts.SyntaxKind[node.kind]);
      }
    }

    function getPropertyName(name: ts.PropertyName): string {
      return mustExist(name.getText());
    }

    return rec(node).stmts;
  }
}

function parseModifiers(modifiersNode?: ts.ModifiersArray): string[] {
  let modifiers: string[] = [];
  if (modifiersNode) {
    modifiersNode.forEach(m => {
      switch (m.kind) {
        case SyntaxKind.ExportKeyword:
          modifiers.push("export");
          break;
        case SyntaxKind.DefaultKeyword:
          modifiers.push("default");
          break;
        case SyntaxKind.ConstKeyword:
          modifiers.push("const");
          break;
        case SyntaxKind.StaticKeyword:
          modifiers.push("static");
          break;
        case SyntaxKind.PublicKeyword:
          modifiers.push("public");
          break;
        default:
      }
    });
  }
  return modifiers;
}

export function flattenBlock(stmts: GStmt[]): GStmt {
  if (stmts.length == 1) {
    return stmts[0];
  } else {
    return new BlockStmt(stmts);
  }
}

export function getSingleton<A>(xs: A[]): A {
  if (xs.length != 1) {
    throw new Error("Expect a singleton collection, but get: " + xs);
  }
  return xs[0];
}


class SpecialVars {
  static spread = new Var("$Spread");
  static typeOf = new Var("$TypeOf");
  static THIS = new Var("this");
  static SUPER = new Var("super");
  static CASE = new Var("$Case");
  static SWITCH = new Var("$Switch");
  static DELETE = new Var("$Delete");
  static ArrayAccess = new Var("$ArrayAccess");
  static YIELD = new Var("$Yield");
}

// utilities
export function flatMap<A, B>(xs: any, f: (x: A) => B[]): B[] {
  return xs.reduce((acc: any, x: A) => acc.concat(f(x)), []);
}

export function forNode<T>(node: ts.Node, action: () => T): T {
  try {
    return action();
  } catch (e) {
    console.debug("Error occurred when processing node: " + node.getText());
    throw e;
  }
}

export function astPath(n: ts.Node): string[] {
  const p = n.parent;
  const path = p ? astPath(p): [];
  path.unshift(SyntaxKind[n.kind]);
  return path;
}

export function getLineNumber(node: ts.Node): number {
  const src = node.getSourceFile();
  let {line} = src.getLineAndCharacterOfPosition(node.getStart());
  return line + 1;
}

export function parseFiles(sources: string[], libraryFiles: string[]): GModule[] {
  let program = ts.createProgram(libraryFiles, {
    target: ts.ScriptTarget.ES2015,
    module: ts.ModuleKind.CommonJS
  });
  // program.getSemanticDiagnostics(null, null); //call this to store type info into nodes

  let checker = program.getTypeChecker();

  let sFiles: ts.SourceFile[] = sources.map(file => mustExist(program.getSourceFile(file),
    "getSourceFile failed for: " + file));
  mustExist(sFiles);

  let parser = new StmtParser();

  return sFiles.map((src, index) => {
    let stmts: GStmt[] = [];
    src.statements.forEach(s => {
      try {
        let r = parser.parseStmt(s, checker);
        r.forEach(s => stmts.push(s));
      } catch (e) {
        console.debug("Parsing failed for file: " + src.fileName);
        const line = getLineNumber(s);
        console.debug(`Failure occurred at line ${line}: ${s.getText()}`);
        console.debug(`Parsing trace: ${astPath(s).join(" <- ")}`);

        throw e;
      }

    });
    return new GModule(sources[index], stmts);
  });
}