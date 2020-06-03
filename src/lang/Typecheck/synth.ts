import * as Immutable from 'immutable';
import Recast from 'recast/main';
import { bug } from '../../util/bug';
import Trace from '../../util/Trace';
import Try from '../../util/Try';
import Type from '../Type';
import * as MDXHAST from '../mdxhast';
import * as ESTree from '../ESTree';
import { AstAnnotations } from '../../data';
import { Env } from './env';
import * as Throw from './throw';
import { check } from './check';
import { narrowType, narrowEnvironment } from './narrow';

function synthIdentifier(
  ast: ESTree.Identifier,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  const type = env.get(ast.name);
  if (type) return type;
  else if (ast.name === 'undefined') return Type.undefined;
  else return Throw.withLocation(ast, `unbound identifier ${ast.name}`, annots);
}

function synthLiteral(
  ast: ESTree.Literal,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  return Type.singleton(ast.value);
}

function synthArrayExpression(
  ast: ESTree.ArrayExpression,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  const types = ast.elements.map(e => synth(e, env, annots, trace));
  const elem = Type.union(...types);
  return Type.array(elem);
}

function synthObjectExpression(
  ast: ESTree.ObjectExpression,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  const seen = new Set();
  const fields: Array<[string, Type]> =
    ast.properties.map(prop => {
      let name: string;
      switch (prop.key.type) {
        case 'Identifier': name = prop.key.name; break;
        case 'Literal': name = prop.key.value; break;
        default: throw new Error('expected Identifier or Literal prop key name');
      }
      if (seen.has(name)) throw new Error('duplicate field name ' + name);
      else seen.add(name);
      return [ name, synth(prop.value, env, annots, trace) ];
    });
  const fieldTypes = fields.map(([name, type]) => ({ [name]: type }));
  return Type.object(Object.assign({}, ...fieldTypes));
}

const typeofType =
  Type.enumerate('undefined', 'boolean', 'number', 'string', 'function', 'object')

function synthUnaryExpression(
  ast: ESTree.UnaryExpression,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  const type = synth(ast.argument, env, annots, trace);

  if (type.kind === 'Singleton') {
    switch (ast.operator) {
      case '!':
        return Type.singleton(!type.value);
      case 'typeof':
        return Type.singleton(typeof type.value);
      default:
        return bug(`unhandled ast ${ast.operator}`);
    }
  } else {
    switch (ast.operator) {
      case '!':
        return Type.boolean;
      case 'typeof':
        return typeofType;
      default:
        return bug(`unhandled ast ${ast.operator}`);
      }
  }
}

function synthLogicalExpression(
  ast: ESTree.LogicalExpression,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  switch (ast.operator) {
    case '&&': {
      const left = synth(ast.left, env, annots, trace);
      if (left.kind === 'Singleton') {
        const right = synth(ast.right, env, annots, trace); // synth even when !left.value
        return !left.value ? left : right;
      } else {
        const rightEnv = narrowEnvironment(env, ast.left, true, annots, trace);
        const right = synth(ast.right, rightEnv, annots, trace);
        return Type.union(narrowType(left, Type.falsy), right);
      }
    }

    case '||': {
      const left = synth(ast.left, env, annots, trace);
      if (left.kind === 'Singleton') {
        const right = synth(ast.right, env, annots, trace); // synth even when left.value
        return left.value ? left : right;
      } else {
        const rightEnv = narrowEnvironment(env, ast.left, false, annots, trace);
        const right = synth(ast.right, rightEnv, annots, trace);
        // TODO(jaked) Type.union(Type.intersection(left, Type.notFalsy), right) ?
        return Type.union(left, right);
      }
    }

    default:
        return bug(`unexpected operator ${ast.operator}`);
  }
}

function synthBinaryExpression(
  ast: ESTree.BinaryExpression,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  let left = synth(ast.left, env, annots, trace);
  let right = synth(ast.right, env, annots, trace);

  if (left.kind === 'Singleton' && right.kind === 'Singleton') {
    // TODO(jaked) handle other operators
    switch (ast.operator) {
      case '===':
        return Type.singleton(left.value === right.value);
      case '!==':
        return Type.singleton(left.value !== right.value);

      case '+': {
        if (left.base.kind === 'number' && right.base.kind === 'number')
          return Type.singleton(left.value + right.value);
        else if (left.base.kind === 'string' && right.base.kind === 'string')
          return Type.singleton(left.value + right.value);
        else return Throw.withLocation(ast, 'incompatible operands to +', annots);
      }

      default:
        return Throw.withLocation(ast, 'unimplemented', annots);
    }
  } else {
    if (left.kind === 'Singleton') left = left.base;
    if (right.kind === 'Singleton') right = right.base;

    // TODO(jaked) handle other operators
    switch (ast.operator) {
      case '===':
      case '!==':
        return Type.boolean;

      case '+': {
        if (left.kind === 'number' && right.kind === 'number')
          return Type.number;
        else if (left.kind === 'string' && right.kind === 'string')
          return Type.string;
        else return Throw.withLocation(ast, 'incompatible operands to +', annots);
      }

      default:
        return Throw.withLocation(ast, 'unimplemented', annots);
    }
  }
}

function synthSequenceExpression(
  ast: ESTree.SequenceExpression,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  ast.expressions.forEach((e, i) => {
    if (i < ast.expressions.length - 1)
      check(e, env, Type.undefined, annots, trace);
  });
  return synth(ast.expressions[ast.expressions.length - 1], env, annots, trace);
}

function synthMemberExpression(
  ast: ESTree.MemberExpression,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
  objectType?: Type | undefined
): Type {
  objectType = objectType || synth(ast.object, env, annots, trace);

  if (objectType.kind === 'Intersection') {
    const memberTypes =
      objectType.types
        // don't annotate AST with possibly spurious errors
        // TODO(jaked) rethink
        .map(type => Try.apply(() => synthMemberExpression(ast, env, undefined, trace, type)));
    if (memberTypes.some(tryType => tryType.type === 'ok')) {
      const retTypes =
        memberTypes.filter(tryType => tryType.type === 'ok')
          .map(tryType => tryType.get());
      return Type.intersection(...retTypes);
    } else {
      if (ast.property.type === 'Identifier')
        Throw.unknownField(ast.property, ast.property.name, annots);
      else
        // TODO(jaked)
        Throw.unknownField(ast.property, '[computed]', annots);
    }
  } else if (objectType.kind === 'Union') {
    const types =
      objectType.types.map(type => synthMemberExpression(ast, env, annots, trace, type));
    return Type.union(...types);

  } else if (ast.computed) {
    switch (objectType.kind) {
      case 'Array':
        check(ast.property, env, Type.number, annots, trace);
        return objectType.elem;

      case 'Tuple': {
        // check against union of valid indexes
        const elems = objectType.elems;
        const validIndexes =
          elems.map((_, i) => Type.singleton(i));
        check(ast.property, env, Type.union(...validIndexes), annots, trace);

        // synth to find out which valid indexes are actually present
        const propertyType = synth(ast.property, env, annots, trace);
        const presentIndexes: Array<number> = [];
        if (propertyType.kind === 'Singleton') {
          presentIndexes.push(propertyType.value);
        } else if (propertyType.kind === 'Union') {
          propertyType.types.forEach(type => {
            if (type.kind === 'Singleton') presentIndexes.push(type.value);
            else bug('expected Singleton');
          });
        } else bug('expected Singleton or Union')

        // and return union of element types of present indexes
        const presentTypes =
          presentIndexes.map(i => elems.get(i) ?? bug());
        return Type.union(...presentTypes);
      }

      case 'Object': {
        // check against union of valid indexes
        const fields = objectType.fields;
        const validIndexes =
          fields.map(({ _1: name }) => Type.singleton(name));
        check(ast.property, env, Type.union(...validIndexes), annots, trace);

        // synth to find out which valid indexes are actually present
        const propertyType = synth(ast.property, env, annots, trace);
        const presentIndexes: Array<string> = [];
        if (propertyType.kind === 'Singleton') {
          presentIndexes.push(propertyType.value);
        } else if (propertyType.kind === 'Union') {
          propertyType.types.forEach(type => {
            if (type.kind === 'Singleton') presentIndexes.push(type.value);
            else throw new Error('expected Singleton');
          });
        } else throw new Error('expected Singleton or Union')

        // and return union of element types of present indexes
        const presentTypes =
          presentIndexes.map(i => {
            const fieldType = fields.find(({ _1: name }) => name === i);
            if (fieldType) return fieldType._2;
            else throw new Error('expected valid index');
          });
        return Type.union(...presentTypes);
      }

      // case 'Module':
      // no computed members on modules, different members may have different atomness
      // (for that matter, maybe we should not have computed members on tuples / objects)

      default:
        return bug('unimplemented synthMemberExpression ' + objectType.kind);
    }
  } else {
    if (ast.property.type === 'Identifier') {
      const name = ast.property.name;
      switch (objectType.kind) {
        case 'string':
          switch (name) {
            case 'startsWith':
              return Type.functionType([Type.string], Type.boolean);
          }
          break;

        case 'number':
          switch (name) {
            case 'toString':
              return Type.functionType([], Type.string);
          }
          break;

        case 'Array':
          switch (name) {
            case 'size': return Type.number;

            case 'some':
            case 'every':
              return Type.functionType(
                [
                  Type.functionType(
                    [ objectType.elem, Type.number, objectType ],
                    Type.boolean
                  )
                ],
                Type.boolean,
              );

            case 'filter':
              return Type.functionType(
                [
                  Type.functionType(
                    [ objectType.elem, Type.number, objectType ],
                    Type.boolean
                  )
                ],
                objectType,
              );

            case 'forEach':
              return Type.functionType(
                [
                  Type.functionType(
                    [ objectType.elem, Type.number, objectType ],
                    Type.undefined
                  )
                ],
                Type.undefined,
              );

            case 'map':
              return Type.functionType(
                [
                  Type.functionType(
                    [ objectType.elem, Type.number, objectType ],
                    Type.reactNodeType // TODO(jaked) temporary
                  )
                ],
                Type.array(Type.reactNodeType),
              );
          }
          break;

        case 'Map':
          switch (name) {
            case 'size': return Type.number;

            case 'set':
              return Type.functionType(
                [ objectType.key, objectType.value ],
                objectType,
              );

            case 'delete':
              return Type.functionType(
                [ objectType.key ],
                objectType,
              );

            case 'clear':
              return Type.functionType([], objectType);

            case 'filter':
              return Type.functionType(
                [
                  Type.functionType(
                    [ objectType.value, objectType.key, objectType ],
                    Type.boolean
                  )
                ],
                objectType,
              );

            case 'toList':
              return Type.functionType([], Type.array(objectType.value));

            case 'update':
              return Type.functionType(
                [ objectType.key, Type.functionType([ objectType.value ], objectType.value) ],
                objectType
              )

            case 'get':
              return Type.functionType(
                [ objectType.key ],
                Type.undefinedOr(objectType.value),
              );
          }
          break;

        case 'Object': {
          const type = objectType.getFieldType(name);
          if (type) return type;
          break;
        }

        case 'Module': {
          const type = objectType.getFieldType(name);
          if (type) return type;
          break;
        }

      }
      Throw.unknownField(ast.property, name, annots);
    } else {
      return bug('expected identifier on non-computed property');
    }
  }
}

function synthCallExpression(
  ast: ESTree.CallExpression,
  env:Env,
  annots?: AstAnnotations,
  trace?: Trace,
  calleeType?: Type | undefined
): Type {
  calleeType = calleeType || synth(ast.callee, env, annots, trace);

  if (calleeType.kind === 'Intersection') {
    const callTypes =
      calleeType.types
        .filter(type => type.kind === 'Function')
        .map(type => Try.apply(() => synthCallExpression(ast, env, annots, trace, type)));
    if (callTypes.some(tryType => tryType.type === 'ok')) {
      const retTypes =
        callTypes.filter(tryType => tryType.type === 'ok')
          .map(tryType => tryType.get());
      return Type.intersection(...retTypes);
    } else {
      // TODO(jaked) better error message
      return Throw.withLocation(ast, 'no matching function type');
    }
  } else if (calleeType.kind === 'Function') {
    if (calleeType.args.size !== ast.arguments.length)
      // TODO(jaked) support short arg lists if arg type contains undefined
      // TODO(jaked) check how this works in Typescript
      Throw.expectedType(ast, `${calleeType.args.size} args`, `${ast.arguments.length}`, annots);
    calleeType.args.forEach((type, i) => check(ast.arguments[i], env, type, annots, trace));
    return calleeType.ret;
  } else {
    return Throw.expectedType(ast.callee, 'function', calleeType, annots)
  }
}

function patTypeEnvIdentifier(
  ast: ESTree.Identifier,
  type: Type,
  env: Env,
  annots?: AstAnnotations,
): Env {
  if (ast.type !== 'Identifier')
    return Throw.withLocation(ast, `incompatible pattern for type ${Type.toString(type)}`, annots);
  if (env.has(ast.name))
    return Throw.withLocation(ast, `identifier ${ast.name} already bound in pattern`, annots);
  return env.set(ast.name, type);
}

function patTypeEnvObjectPattern(
  ast: ESTree.ObjectPattern,
  t: Type.ObjectType,
  env: Env,
  annots?: AstAnnotations,
): Env {
  ast.properties.forEach(prop => {
    const key = prop.key;
    const field = t.fields.find(field => field._1 === key.name)
    if (!field)
      return Throw.unknownField(key, key.name, annots);
    env = patTypeEnv(prop.value, field._2, env, annots);
  });
  return env;
}

function patTypeEnv(
  ast: ESTree.Pattern,
  t: Type,
  env: Env,
  annots?: AstAnnotations,
): Env {
  if (ast.type === 'ObjectPattern' && t.kind === 'Object')
    return patTypeEnvObjectPattern(ast, t, env, annots);
  else if (ast.type === 'Identifier')
    return patTypeEnvIdentifier(ast, t, env, annots);
  else
    return Throw.withLocation(ast, `incompatible pattern for type ${Type.toString(t)}`, annots);
}

function synthArrowFunctionExpression(
  ast: ESTree.ArrowFunctionExpression,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  let patEnv: Env = Immutable.Map();
  const paramTypes = ast.params.map(param => {
    if (!param.typeAnnotation)
      return Throw.withLocation(param, `function parameter must have a type`, annots);
    const t = Type.ofTSType(param.typeAnnotation.typeAnnotation);
    patEnv = patTypeEnv(param, t, patEnv, annots);
    return t;
  });
  env = env.concat(patEnv);
  const type = synth(ast.body, env, annots, trace);
  return Type.functionType(paramTypes, type);
}

function synthConditionalExpression(
  ast: ESTree.ConditionalExpression,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  const testType = synth(ast.test, env, annots, trace);

  if (testType.kind === 'Singleton') {
    if (testType.value) {
      const envConsequent = narrowEnvironment(env, ast.test, true, annots, trace);
      return synth(ast.consequent, envConsequent, annots, trace);
    } else {
      const envAlternate = narrowEnvironment(env, ast.test, false, annots, trace);
      return synth(ast.alternate, envAlternate, annots, trace);
    }
  } else {
    const envConsequent = narrowEnvironment(env, ast.test, true, annots, trace);
    const envAlternate = narrowEnvironment(env, ast.test, false, annots, trace);
    const consequent = synth(ast.consequent, envConsequent, annots, trace);
    const alternate = synth(ast.alternate, envAlternate, annots, trace);
    return Type.union(consequent, alternate);
  }
}

function synthTemplateLiteral(
  ast: ESTree.TemplateLiteral,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  // TODO(jaked) handle interpolations
  return Type.string;
}

function synthJSXIdentifier(
  ast: ESTree.JSXIdentifier,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  const type = env.get(ast.name);
  if (type) return type;
  else throw new Error('unbound identifier ' + ast.name);
}

function synthJSXElement(
  ast: ESTree.JSXElement,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  const type = synth(ast.openingElement.name, env, annots, trace);

  let propsType: Type.ObjectType;
  let retType: Type;
  if (type.kind === 'Function') {
    retType = type.ret;
    if (type.args.size === 0) {
      propsType = Type.object({});
    } else if (type.args.size === 1) {
      const argType = type.args.get(0) ?? bug();
      if (argType.kind !== 'Object')
        throw new Error('expected object arg');
      propsType = argType;
      const childrenField = propsType.fields.find(field => field._1 === 'children');
      if (childrenField) {
        if (!Type.isSubtype(Type.array(Type.reactNodeType), childrenField._2))
          throw new Error('expected children type');
      }
    } else throw new Error('expected 0- or 1-arg function');

  // TODO(jaked) consolidate with type expansions in Check.checkAbstract
  } else if (type.kind === 'Abstract' && type.label === 'React.FC' && type.params.size === 1) {
    const paramType = type.params.get(0) ?? bug();
    if (paramType.kind !== 'Object')
      throw new Error('expected object arg');
    retType = Type.reactNodeType;
    propsType = paramType;

  } else if (type.kind === 'Abstract' && type.label === 'React.Component' && type.params.size === 1) {
    const paramType = type.params.get(0) ?? bug();
    if (paramType.kind !== 'Object')
      throw new Error('expected object arg');
    retType = Type.reactElementType;
    propsType = paramType;

  } else {
    Throw.expectedType(ast.openingElement.name, 'component type', type, annots);
  }

  const attrNames =
    new Set(ast.openingElement.attributes.map(({ name }) => name.name ));
  propsType.fields.forEach(({ _1: name, _2: type }) => {
    if (name !== 'children' &&
        !attrNames.has(name) &&
        !Type.isSubtype(Type.undefined, type))
      // TODO(jaked) it would be better to mark the whole JSXElement as having an error
      // but for now this get us the right error highlighting in Editor
      Throw.missingField(ast.openingElement.name, name, annots);
  });

  const propTypes = new Map(propsType.fields.map(({ _1, _2 }) => [_1, _2]));
  ast.openingElement.attributes.forEach(attr => {
    const type = propTypes.get(attr.name.name);
    if (type) return check(attr.value, env, type, annots, trace);
    else {
      return Throw.extraField(attr, attr.name.name, annots);
    }
  });

  ast.children.map(child =>
    // TODO(jaked) see comment about recursive types on Type.reactNodeType
    check(child, env, Type.union(Type.reactNodeType, Type.array(Type.reactNodeType)), annots, trace)
  );

  return retType;
}

function synthJSXFragment(
  ast: ESTree.JSXFragment,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  const types = ast.children.map(e => synth(e, env, annots, trace));
  const elem = Type.union(...types);
  return Type.array(elem);
  // TODO(jaked) we know children should satisfy `reactNodeType`
  // we could check that explicitly (as above in synthJSXElement)
  // see also comments on checkArray and checkUnion
}

function synthJSXExpressionContainer(
  ast: ESTree.JSXExpressionContainer,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  return synth(ast.expression, env, annots, trace);
}

function synthJSXText(
  ast: ESTree.JSXText,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  return Type.string;
}

function synthJSXEmptyExpression(
  ast: ESTree.JSXEmptyExpression,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  return Type.undefined;
}

function synthHelper(
  ast: ESTree.Expression,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  switch (ast.type) {
    case 'Identifier':              return synthIdentifier(ast, env, annots, trace);
    case 'Literal':                 return synthLiteral(ast, env, annots, trace);
    case 'ArrayExpression':         return synthArrayExpression(ast, env, annots, trace);
    case 'ObjectExpression':        return synthObjectExpression(ast, env, annots, trace);
    case 'ArrowFunctionExpression': return synthArrowFunctionExpression(ast, env, annots, trace);
    case 'UnaryExpression':         return synthUnaryExpression(ast, env, annots, trace);
    case 'LogicalExpression':       return synthLogicalExpression(ast, env, annots, trace);
    case 'BinaryExpression':        return synthBinaryExpression(ast, env, annots, trace);
    case 'SequenceExpression':      return synthSequenceExpression(ast, env, annots, trace);
    case 'MemberExpression':        return synthMemberExpression(ast, env, annots, trace);
    case 'CallExpression':          return synthCallExpression(ast, env, annots, trace);
    case 'ConditionalExpression':   return synthConditionalExpression(ast, env, annots, trace);
    case 'TemplateLiteral':         return synthTemplateLiteral(ast, env, annots, trace);
    case 'JSXIdentifier':           return synthJSXIdentifier(ast, env, annots, trace);
    case 'JSXElement':              return synthJSXElement(ast, env, annots, trace);
    case 'JSXFragment':             return synthJSXFragment(ast, env, annots, trace);
    case 'JSXExpressionContainer':  return synthJSXExpressionContainer(ast, env, annots, trace);
    case 'JSXText':                 return synthJSXText(ast, env, annots, trace);
    case 'JSXEmptyExpression':      return synthJSXEmptyExpression(ast, env, annots, trace);

    default:
      return bug(`unimplemented AST ${ast.type}`);
  }
}

export function synth(
  ast: ESTree.Expression,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  try {
    const type = trace ?
      trace.time(Recast.print(ast).code, () => synthHelper(ast, env, annots, trace)) :
      synthHelper(ast, env, annots, trace);
    if (annots) annots.set(ast, type);
    return type;
  } catch (e) {
    if (annots) annots.set(ast, Type.error(e));
    throw e;
  }
}

function extendEnvWithImport(
  decl: ESTree.ImportDeclaration,
  moduleEnv: Immutable.Map<string, Type.ModuleType>,
  env: Env,
  annots?: AstAnnotations,
): Env {
  const module = moduleEnv.get(decl.source.value);
  if (!module)
    return Throw.withLocation(decl.source, `no module '${decl.source.value}'`, annots);
  decl.specifiers.forEach(spec => {
    switch (spec.type) {
      case 'ImportNamespaceSpecifier':
        env = env.set(spec.local.name, module);
        break;
      case 'ImportDefaultSpecifier':
        const defaultField = module.fields.find(ft => ft._1 === 'default');
        if (!defaultField)
          return Throw.withLocation(decl.source, `no default export on '${decl.source.value}'`, annots);
        env = env.set(spec.local.name, defaultField._2);
        break;
      case 'ImportSpecifier':
        const importedField = module.fields.find(ft => ft._1 === spec.imported.name)
        if (!importedField)
          return Throw.withLocation(decl.source, `no exported member '${spec.imported.name}' on '${decl.source.value}'`, annots);
        env = env.set(spec.local.name, importedField._2);
        break;
    }
  });
  return env;
}

function extendEnvWithNamedExport(
  decl: ESTree.ExportNamedDeclaration,
  exportTypes: { [s: string]: Type },
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Env {
  decl.declaration.declarations.forEach(declarator => {
    let type;
    if (declarator.id.typeAnnotation) {
      type = Type.ofTSType(declarator.id.typeAnnotation.typeAnnotation);
      check(declarator.init, env, type, annots, trace);
    } else {
      type = synth(declarator.init, env, annots, trace);
    }
    exportTypes[declarator.id.name] = type;
    env = env.set(declarator.id.name, type);
  });
  return env;
}

function extendEnvWithDefaultExport(
  decl: ESTree.ExportDefaultDeclaration,
  exportTypes: { [s: string]: Type },
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Env {
  exportTypes['default'] = synth(decl.declaration, env, annots, trace);
  return env;
}

// TODO(jaked) this interface is a little weird
export function synthMdx(
  ast: MDXHAST.Node,
  moduleEnv: Immutable.Map<string, Type.ModuleType>,
  env: Env,
  exportTypes: { [s: string]: Type },
  annots?: AstAnnotations,
  trace?: Trace,
): Env {
  switch (ast.type) {
    case 'root':
    case 'element':
      ast.children.forEach(child =>
        env = synthMdx(child, moduleEnv, env, exportTypes, annots, trace)
      );
      return env;

    case 'text':
      return env;

    case 'jsx':
      if (!ast.jsxElement) throw new Error('expected JSX node to be parsed');
      ast.jsxElement.forEach(elem => check(elem, env, Type.reactNodeType, annots, trace));
      return env;

    case 'import':
    case 'export': {
      if (!ast.declarations) throw new Error('expected import/export node to be parsed');
      ast.declarations.forEach(decls => decls.forEach(decl => {
        switch (decl.type) {
          case 'ImportDeclaration':
            env = extendEnvWithImport(decl, moduleEnv, env, annots);
            break;

          case 'ExportNamedDeclaration':
            env = extendEnvWithNamedExport(decl, exportTypes, env, annots, trace);
            break;

          case 'ExportDefaultDeclaration':
            env = extendEnvWithDefaultExport(decl, exportTypes, env, annots, trace);
            break;
        }
      }));
      return env;
    }

    default: throw new Error('unexpected AST ' + (ast as MDXHAST.Node).type);
  }
}
