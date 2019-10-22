import * as Immutable from 'immutable';
import * as React from 'react';
import * as AcornJsxAst from '../lang/acornJsxAst';

import { Cell } from '../util/Cell';

const STARTS_WITH_CAPITAL_LETTER = /^[A-Z]/

export type Env = Immutable.Map<string, any>;

function patValueEnvIdentifier(ast: AcornJsxAst.Identifier, value: any, env: Env): Env {
  return env.set(ast.name, value);
}

function patValueEnvObjectPattern(ast: AcornJsxAst.ObjectPattern, value: any, env: Env): Env {
  ast.properties.forEach(prop => {
    env = patValueEnv(prop.value, value[prop.key.name], env);
  });
  return env;
}

function patValueEnv(ast: AcornJsxAst.Pattern, value: any, env: Env): Env {
  if (ast.type === 'Identifier')
    return patValueEnvIdentifier(ast, value, env);
  else if (ast.type === 'ObjectPattern')
    return patValueEnvObjectPattern(ast, value, env);
  else throw new Error(`unexpected AST type ${(ast as AcornJsxAst.Pattern).type}`);
}

export function evaluateExpression(
  ast: AcornJsxAst.Expression,
  env: Env,
): any {
  switch (ast.type) {
    case 'Literal':
      return ast.value;

    case 'Identifier': {
      const value = env.get(ast.name);
      if (typeof value === 'undefined')
        throw new Error(`unbound identifier ${ast.name}`);
      if (typeof ast.etype === 'undefined')
        throw new Error('expected AST to be typechecked');
      const { atom } = ast.etype.get();
      if (atom) {
        return (<Cell<any>>value).get();
      } else {
        return value;
      }
    }

    case 'JSXExpressionContainer':
      return evaluateExpression(ast.expression, env);

    case 'JSXText': {
      const value = ast.value.trim();
      if (value === '') return null;
      else return value;
    }

    case 'JSXElement': {
      const attrObjs = ast.openingElement.attributes.map(({ name, value }) => {
        return { [name.name]: evaluateExpression(value, env) };
      });
      const attrs = Object.assign({}, ...attrObjs);

      let elem: any;
      const name = ast.openingElement.name.name;
      if (STARTS_WITH_CAPITAL_LETTER.test(name)) {
        elem = env.get(name);
        if (typeof elem === 'undefined')
          throw new Error(`unbound identifier ${name}`);
      } else if (name === 'a') {
        // TODO(jaked) fix hack somehow
        elem = env.get('Link');
        attrs['to'] = attrs['href']
      } else {
        elem = name;
      }

      // TODO(jaked) for what elements does this make sense? only input?
      if (name === 'input' && attrs.id) {
        if (env.has(attrs.id)) {
          const atom = env.get(attrs.id) as Cell<any>;
          attrs.onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
            atom.set(e.currentTarget.value);
          }
        } else {
          // TODO(jaked) check statically
          // also check that it is a non-readonly Atom
          throw new Error('unbound identifier ' + attrs.id);
        }
      }

      const children = ast.children.map(child => evaluateExpression(child, env));
      return React.createElement(elem, attrs, ...children)
    }

    case 'JSXFragment':
      return ast.children.map(child => evaluateExpression(child, env));

    case 'BinaryExpression': {
      // TODO(jaked) short-circuit booleans
      const lv = evaluateExpression(ast.left, env);
      const rv = evaluateExpression(ast.right, env);
      switch (ast.operator) {
        case '+': return lv + rv;
        case '-': return lv - rv;
        case '*': return lv * rv;
        case '/': return lv / rv;
        case '**': return lv ** rv;
        case '%': return lv % rv;
        case '==': return lv == rv;
        case '!=': return lv != rv;
        case '===': return lv === rv;
        case '!==': return lv !== rv;
        case '<': return lv < rv;
        case '<=': return lv <= rv;
        case '>': return lv > rv;
        case '>=': return lv >= rv;
        case '||': return lv || rv;
        case '&&': return lv && rv;
        case '|': return lv | rv;
        case '&': return lv & rv;
        case '^': return lv ^ rv;
        case '<<': return lv << rv;
        case '>>': return lv >> rv;
        case '>>>': return lv >>> rv;
        default:
          throw new Error(`unexpected binary operator ${ast.operator}`)
      }
    }

    case 'MemberExpression': {
      let value: any;
      const object = evaluateExpression(ast.object, env);
      if (ast.computed) {
        const property = evaluateExpression(ast.property, env);
        value = object[property];
      } else {
        if (ast.property.type !== 'Identifier')
          throw new Error('expected identifier on non-computed property');
        value = object[ast.property.name];
      }
      if (typeof ast.etype === 'undefined')
        throw new Error('expected AST to be typechecked');
      const { atom } = ast.etype.get();
      if (atom) {
        return (<Cell<any>>value).get();
      } else {
        return value;
      }
    }

    case 'CallExpression': {
      const callee = evaluateExpression(ast.callee, env);
      const args = ast.arguments.map(arg => evaluateExpression(arg, env));
      return callee(args);
    }

    case 'ObjectExpression': {
      const properties = ast.properties.map(prop => {
        const value = evaluateExpression(prop.value, env);
        return Object.assign({}, prop, { value })
      });
      return Object.assign({}, ...properties.map(prop => {
        let name: string;
        switch (prop.key.type) {
          case 'Identifier': name = prop.key.name; break;
          case 'Literal': name = prop.key.value; break;
          default: throw new Error('expected Identifier or Literal prop key name');
        }
        return { [name]: prop.value }
      }));
    }

    case 'ArrayExpression':
      return ast.elements.map(e => evaluateExpression(e, env));

    case 'ArrowFunctionExpression':
      return function(...args: Array<any>) {
        ast.params.forEach((pat, i) => {
          env = patValueEnv(pat, args[i], env);
        });
        return evaluateExpression(ast.body, env);
      };

    default:
      throw new Error('unexpected AST ' + (ast as any).type);
  }
}
