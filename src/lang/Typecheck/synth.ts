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
import * as Error from './error';
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
  else return Error.withLocation(ast, `unbound identifier ${ast.name}`, annots);
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
  const fieldTypes: Array<{ [n: string]: Type }> =
    ast.properties.map(prop => {
      let name: string;
      switch (prop.key.type) {
        case 'Identifier': name = prop.key.name; break;
        case 'Literal': name = prop.key.value; break;
        default: bug('expected Identifier or Literal prop key name');
      }
      if (seen.has(name)) Error.withLocation(prop, 'duplicate field name ' + name, annots);
      else seen.add(name);
      return { [name]: synth(prop.value, env, annots, trace) };
    });
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

  switch (type.kind) {
    case 'Error':
      switch (ast.operator) {
        case '!':
          return Type.singleton(true);
        case 'typeof':
          return Type.singleton('error');
        default:
          bug(`unhandled ast ${ast.operator}`);
      }

    case 'Singleton':
      switch (ast.operator) {
        case '!':
          return Type.singleton(!type.value);
        case 'typeof':
          return Type.singleton(typeof type.value);
        default:
          bug(`unhandled ast ${ast.operator}`);
      }

    default:
      switch (ast.operator) {
        case '!':
          return Type.boolean;
        case 'typeof':
          return typeofType;
        default:
          bug(`unhandled ast ${ast.operator}`);
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

      switch (left.kind) {
        case 'Error': {
          const right = synth(ast.right, env, annots, trace);
          return Type.singleton(false);
        }

        case 'Singleton': {
          const right = synth(ast.right, env, annots, trace); // synth even when !left.value
          return !left.value ? left : right;
        }

        default: {
          const rightEnv = narrowEnvironment(env, ast.left, true, annots, trace);
          const right = synth(ast.right, rightEnv, annots, trace);
          return Type.union(narrowType(left, Type.falsy), right);
        }
      }
    }

    case '||': {
      const left = synth(ast.left, env, annots, trace);

      switch (left.kind) {
        case 'Error': {
          return synth(ast.right, env, annots, trace);
        }

        case 'Singleton': {
          const right = synth(ast.right, env, annots, trace); // synth even when left.value
          return left.value ? left : right;
        }

        default: {
          const rightEnv = narrowEnvironment(env, ast.left, false, annots, trace);
          const right = synth(ast.right, rightEnv, annots, trace);
          // TODO(jaked) Type.union(Type.intersection(left, Type.notFalsy), right) ?
          return Type.union(left, right);
        }
      }
    }

    default:
      bug(`unexpected operator ${ast.operator}`);
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

  if (left.kind === 'Error') return left;
  else if (right.kind === 'Error') return right;

  else if (left.kind === 'Singleton' && right.kind === 'Singleton') {
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
        else return Error.withLocation(ast, 'incompatible operands to +', annots);
      }

      default:
        bug(`unimplemented operator ${ast.operator}`);
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
        else return Error.withLocation(ast, 'incompatible operands to +', annots);
      }

      default:
        bug(`unimplemented operator ${ast.operator}`);
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
      // TODO(jaked) undefined or error
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

  if (objectType.kind === 'Error') {
    return objectType;
  } else if (objectType.kind === 'Intersection') {
    const memberTypes =
      objectType.types
        // don't annotate AST with possibly spurious errors
        // TODO(jaked) rethink
        .map(type => synthMemberExpression(ast, env, undefined, trace, type));
    if (memberTypes.every(type => type.kind === 'Error')) {
      if (ast.property.type === 'Identifier')
        return Error.unknownField(ast.property, ast.property.name, annots);
      else
        // TODO(jaked) could result from error in computed property
        return Error.unknownField(ast.property, '[computed]', annots);
    } else {
      const retTypes = memberTypes.filter(type => type.kind !== 'Error');
      return Type.intersection(...retTypes);
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
            else bug('expected Singleton');
          });
        } else bug('expected Singleton or Union')

        // and return union of element types of present indexes
        const presentTypes =
          presentIndexes.map(i => {
            const fieldType = fields.find(({ _1: name }) => name === i);
            if (fieldType) return fieldType._2;
            else bug('expected valid index');
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
    if (ast.property.type !== 'Identifier')
      bug('expected identifier on non-computed property');

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
    return Error.unknownField(ast.property, name, annots);
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
        .map(type => synthCallExpression(ast, env, undefined, trace, type));
    const okTypes = callTypes.filter(type => type.kind !== 'Error');
    switch (okTypes.size) {
      case 0:
        // TODO(jaked) better error message
        return Error.withLocation(ast, 'no matching function type');
      case 1: {
        const okCalleeType =
          calleeType.types.get(callTypes.findIndex(type => type.kind !== 'Error'));
        // redo for annots. TODO(jaked) immutable update for annots
        return synthCallExpression(ast, env, annots, trace, okCalleeType);
      }
      default:
        // TODO(jaked)
        // we don't want to annotate arg ASTs with multiple types
        // for different branches of intersection.
        // for evaluation, dynamic semantics depend on types
        //   so we need concrete types
        //   or could elaborate to dynamic type tests
        //     with concrete types in each branch
        // for editor, it's just confusing, what else could we do?
        // TODO(jaked) better error message
        return Error.withLocation(ast, 'too many matching function types');
    }
  } else if (calleeType.kind === 'Function') {
    if (calleeType.args.size !== ast.arguments.length)
      // TODO(jaked) support short arg lists if arg type contains undefined
      // TODO(jaked) check how this works in Typescript
      return Error.expectedType(ast, `${calleeType.args.size} args`, `${ast.arguments.length}`, annots);
    const types = calleeType.args.map((type, i) =>
    check(ast.arguments[i], env, type, annots, trace)
    );
    // TODO(jaked) error ok where undefined ok
    const error = types.find(type => type.kind === 'Error');
    if (error) return error;
    else return calleeType.ret;
  } else {
    return Error.expectedType(ast.callee, 'function', calleeType, annots)
  }
}

function patTypeEnvIdentifier(
  ast: ESTree.Identifier,
  type: Type,
  env: Env,
  annots?: AstAnnotations,
): Env {
  if (env.has(ast.name)) {
    Error.withLocation(ast, `identifier ${ast.name} already bound in pattern`, annots);
    return env;
  } else {
    return env.set(ast.name, type);
  }
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
    if (!field) {
      Error.unknownField(key, key.name, annots);
    } else {
      env = patTypeEnv(prop.value, field._2, env, annots);
    }
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
  else {
    Error.withLocation(ast, `incompatible pattern for type ${Type.toString(t)}`, annots);
    return env;
  }
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
      return Error.withLocation(param, `function parameter must have a type`, annots);
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

  // when the test has a static value we don't synth the untaken branch
  // this is a little weird but consistent with typechecking
  // only as much as needed to run the program
  switch (testType.kind) {
    case 'Error': {
      const envAlternate = narrowEnvironment(env, ast.test, false, annots, trace);
      return synth(ast.alternate, envAlternate, annots, trace);
    }

    case 'Singleton':
      if (testType.value) {
        const envConsequent = narrowEnvironment(env, ast.test, true, annots, trace);
        return synth(ast.consequent, envConsequent, annots, trace);
      } else {
        const envAlternate = narrowEnvironment(env, ast.test, false, annots, trace);
        return synth(ast.alternate, envAlternate, annots, trace);
      }

    default: {
      const envConsequent = narrowEnvironment(env, ast.test, true, annots, trace);
      const envAlternate = narrowEnvironment(env, ast.test, false, annots, trace);
      const consequent = synth(ast.consequent, envConsequent, annots, trace);
      const alternate = synth(ast.alternate, envAlternate, annots, trace);
      return Type.union(consequent, alternate);
    }
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
  else return Error.withLocation(ast, 'unbound identifier ' + ast.name, annots);
}

function synthJSXElement(
  ast: ESTree.JSXElement,
  env: Env,
  annots?: AstAnnotations,
  trace?: Trace,
): Type {
  const type = synth(ast.openingElement.name, env, annots, trace);

  const [ propsType, retType ] = ((): [ Type.ObjectType, Type.Type ] => {
    switch (type.kind) {
      case 'Error':
        return [ Type.object({}), type ]

      case 'Function':
        if (type.args.size === 0) {
          return [ Type.object({}), type.ret ];
        } else if (type.args.size === 1) {
          const argType = type.args.get(0) ?? bug();
          if (argType.kind === 'Object') {
            const childrenField = argType.fields.find(field => field._1 === 'children');
            if (!childrenField || Type.isSubtype(Type.array(Type.reactNodeType), childrenField._2))
              return [ argType, type.ret ];
          }
        }
        break;

      // TODO(jaked) consolidate with type expansions in Check.checkAbstract
      case 'Abstract':
        switch (type.label) {
          case 'React.FC':
          case 'React.FunctionComponent':
            if (type.params.size === 1) {
              const paramType = type.params.get(0) ?? bug();
              if (paramType.kind === 'Object')
                return [ paramType, Type.reactNodeType ]
            }
            break;

          case 'React.Component':
            if (type.params.size === 1) {
              const paramType = type.params.get(0) ?? bug();
              if (paramType.kind === 'Object')
                return [ paramType, Type.reactElementType ]
            }
            break;
        }
        break;
    }
    return [ Type.object({}), Error.expectedType(ast.openingElement.name, 'component type', type, annots) ];
  })();

  const attrNames =
    new Set(ast.openingElement.attributes.map(({ name }) => name.name ));
  propsType.fields.forEach(({ _1: name, _2: type }) => {
    if (name !== 'children' &&
        !attrNames.has(name) &&
        !Type.isSubtype(Type.undefined, type))
      // TODO(jaked) it would be better to mark the whole JSXElement as having an error
      // but for now this get us the right error highlighting in Editor
      Error.missingField(ast.openingElement.name, name, annots);
  });

  const propTypes = new Map(propsType.fields.map(({ _1, _2 }) => [_1, _2]));
  ast.openingElement.attributes.forEach(attr => {
    const type = propTypes.get(attr.name.name);
    if (type) check(attr.value, env, type, annots, trace);
    else Error.extraField(attr, attr.name.name, annots);
  });

  ast.children.map(child =>
    // TODO(jaked) see comment about recursive types on Type.reactNodeType
    check(child, env, Type.union(Type.reactNodeType, Type.array(Type.reactNodeType)), annots, trace)
  );

  // TODO(jaked) if args has error, return is error
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
  if (!module) {
    const error = Error.withLocation(decl.source, `no module '${decl.source.value}'`, annots);
    decl.specifiers.forEach(spec => {
      env = env.set(spec.local.name, error);
    });
  } else {
    decl.specifiers.forEach(spec => {
      switch (spec.type) {
        case 'ImportNamespaceSpecifier': {
          env = env.set(spec.local.name, module);
        }
        break;

        case 'ImportDefaultSpecifier': {
          const defaultField = module.fields.find(ft => ft._1 === 'default');
          if (defaultField) {
            env = env.set(spec.local.name, defaultField._2);
          } else {
            const error = Error.withLocation(spec.local, `no default export on '${decl.source.value}'`, annots);
            env = env.set(spec.local.name, error);
          }
        }
        break;

        case 'ImportSpecifier': {
          const importedField = module.fields.find(ft => ft._1 === spec.imported.name)
          if (importedField) {
            env = env.set(spec.local.name, importedField._2);
          } else {
            const error = Error.withLocation(spec.imported, `no exported member '${spec.imported.name}' on '${decl.source.value}'`, annots);
            env = env.set(spec.local.name, error);
          }
        }
        break;
      }
    });
  }
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
      if (!ast.jsxElement) bug('expected JSX node to be parsed');
      ast.jsxElement.forEach(elem => check(elem, env, Type.reactNodeType, annots, trace));
      return env;

    case 'import':
    case 'export': {
      if (!ast.declarations) bug('expected import/export node to be parsed');
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

    default: bug('unexpected AST ' + (ast as MDXHAST.Node).type);
  }
}
