import * as Immer from 'immer';
import { bug } from '../../util/bug';
import Try from '../../util/Try';
import * as PMAST from '../../model/PMAST';
import * as ESTree from '../ESTree';
import Type from '../Type';
import * as Render from '../Render';
import * as JS from '@babel/types';
import babelGenerator from '@babel/generator';

const reactFragment = JS.memberExpression(JS.identifier('React'), JS.identifier('Fragment'));

const e = (el: JS.Expression, attrs: { [s: string]: JS.Expression }, ...children: JS.Expression[]) =>
  JS.callExpression(
    JS.identifier('__e'),
    [
      el,
      JS.objectExpression(Object.keys(attrs).map(key => JS.objectProperty(JS.identifier(key), attrs[key]))),
      ...children
    ]
  )

function genParam(
  param: ESTree.Pattern
): JS.Identifier | JS.Pattern {
  switch (param.type) {
    case 'Identifier':
      return JS.identifier(param.name);

    case 'ObjectPattern':
      return JS.objectPattern(param.properties.map(prop => {
        if (prop.key.type !== 'Identifier') bug(`expected Identifier`);
        return JS.objectProperty(JS.identifier(prop.key.name), genParam(prop.value));
      }));

    default: bug(`unimplemented ${(param as ESTree.Pattern).type}`);
  }
}

const STARTS_WITH_CAPITAL_LETTER = /^[A-Z]/

function genExpr(
  ast: ESTree.Expression,
  typesMap: (e: ESTree.Expression) => Type,
  env: Map<string, JS.Expression>,
): JS.Expression {
  const type = typesMap(ast);
  if (type.kind === 'Error')
    return JS.identifier('undefined');

    switch (ast.type) {
    case 'Identifier':
      return env.get(ast.name) ?? JS.identifier(ast.name);

    case 'Literal':
      switch (typeof ast.value) {
        case 'boolean': return JS.booleanLiteral(ast.value);
        case 'number':  return JS.numericLiteral(ast.value);
        case 'string':  return JS.stringLiteral(ast.value);
        default: bug(`unexpected literal type ${typeof ast.value}`);
      }

    case 'JSXExpressionContainer':
      return genExpr(ast.expression, typesMap, env);

    case 'JSXEmptyExpression':
      return JS.identifier('undefined');

    case 'JSXText': {
      // whitespace trimming is not specified in JSX
      // but it is necessary for components (e.g. Victory) that process their children
      // we follow Babel, see
      // https://github.com/calebmer/node_modules/tree/master/babel-plugin-transform-jsx#trimming
      // TODO(jaked) should do this in parsing insted of eval
      const value = ast.value.replace(/\n\s*/g, '')
      if (value === '') return JS.nullLiteral();
      else return JS.stringLiteral(value);
    }

    case 'JSXElement': {
      const attrObjs = ast.openingElement.attributes.map(({ name, value }) => {
        if (!value) return { [name.name]: true }
        else return { [name.name]: genExpr(value, typesMap, env) };
      });
      const attrs = Object.assign({}, ...attrObjs);

      const name = ast.openingElement.name.name;
      return e(
        STARTS_WITH_CAPITAL_LETTER.test(name) ?  JS.identifier(name) : JS.stringLiteral(name),
        attrs,
        ...ast.children.map(child => genExpr(child, typesMap, env))
      );
    }

    case 'JSXFragment':
      return e(
        reactFragment,
        {},
        ...ast.children.map(child => genExpr(child, typesMap, env))
      );

    case 'UnaryExpression': {
      const argType = typesMap(ast.argument);
      const v = genExpr(ast.argument, typesMap, env);
      switch (ast.operator) {
        case '+':
        case '-':
        case '!':
          return JS.unaryExpression(ast.operator, v);
        case 'typeof':
          if (argType.kind === 'Error')
            return JS.stringLiteral('error');
          else
            return JS.unaryExpression('typeof', v);
        default: bug(`unimplemented ${(ast as ESTree.UnaryExpression).operator}`);
      }
    }

    case 'LogicalExpression': {
      return JS.logicalExpression(
        ast.operator,
        genExpr(ast.left, typesMap, env),
        genExpr(ast.right, typesMap, env),
      );
    }

    case 'BinaryExpression': {
      const left = genExpr(ast.left, typesMap, env);
      const right = genExpr(ast.right, typesMap, env);
      const leftType = typesMap(ast.left);
      const rightType = typesMap(ast.right);

      switch (ast.operator) {
        case '+':
        case '-':
        case '*':
        case '/':
        case '%':
          if (leftType.kind === 'Error') return right;
          else if (rightType.kind === 'Error') return left;
          else return JS.binaryExpression(ast.operator, left, right);

        case '===':
          if (leftType.kind === 'Error' || rightType.kind === 'Error')
            return JS.booleanLiteral(false);
          else
            return JS.binaryExpression('===', left, right);

        case '!==':
          if (leftType.kind === 'Error' || rightType.kind === 'Error')
            return JS.booleanLiteral(true);
          else
            return JS.binaryExpression('!==', left, right);

        default:
          bug(`unimplemented ${ast.operator}`);
      }
    }

    case 'SequenceExpression':
      return JS.sequenceExpression(ast.expressions.map(expr => genExpr(expr, typesMap, env)));

    case 'MemberExpression': {
      let property;
      if (ast.computed) {
        property = genExpr(ast.property, typesMap, env);
      } else if (ast.property.type === 'Identifier') {
        property = JS.identifier(ast.property.name);
      } else {
        bug (`expected identifier ${JSON.stringify(ast.property)}`);
      }
      return JS.memberExpression(genExpr(ast.object, typesMap, env), property);
    }

    case 'CallExpression':
      return JS.callExpression(
        genExpr(ast.callee, typesMap, env),
        ast.arguments.map(arg => genExpr(arg, typesMap, env))
      );

    case 'ObjectExpression':
      return JS.objectExpression(ast.properties.map(prop => {
        let key;
        if (prop.computed) {
          key = genExpr(prop.key, typesMap, env);
        } else if (prop.key.type === 'Identifier') {
          key = JS.identifier(prop.key.name);
        } else {
          bug (`expected identifier ${JSON.stringify(prop.key)}`);
        }
        return JS.objectProperty(key, genExpr(prop.value, typesMap, env));
      }));

    case 'ArrayExpression':
      return JS.arrayExpression(ast.elements.map(e => genExpr(e, typesMap, env)));

    case 'ArrowFunctionExpression': {
      if (ast.body.type === 'BlockStatement') {
        const stmts = ast.body.body.map(stmt => {
          switch (stmt.type) {
            case 'ExpressionStatement':
              return JS.expressionStatement(genExpr(stmt.expression, typesMap, env));
            default:
              bug(`unimplemented ${stmt.type}`);
          }
        });
        return JS.arrowFunctionExpression(ast.params.map(genParam), JS.blockStatement(stmts));
      } else {
        return JS.arrowFunctionExpression(ast.params.map(genParam), genExpr(ast.body, typesMap, env));
      }
    }

    case 'ConditionalExpression':
      return JS.conditionalExpression(
        genExpr(ast.test, typesMap, env),
        genExpr(ast.consequent, typesMap, env),
        genExpr(ast.alternate, typesMap, env),
      );

    default:
      bug(`unimplemented ${ast.type}`);
  }
}

function genDynamicExpr(
  ast: ESTree.Expression,
  typesMap: (e: ESTree.Expression) => Type,
  dynamicEnv: Render.DynamicEnv,
  valueEnv: Map<string, JS.Expression>,
): JS.Expression {
  const type = typesMap(ast);
  if (type.kind === 'Error') return JS.identifier('undefined');
  const idents = ESTree.freeIdentifiers(ast).filter(ident => {
    return dynamicEnv.get(ident) ?? false;
  });
  const signals = idents.map(ident => valueEnv.get(ident) ?? JS.identifier(ident));
  // shadow the bindings of things in the global environment
  const env2 = Immer.produce(valueEnv, env => {
    idents.forEach(ident => {
      (env as Map<string, JS.Expression>).set(ident, JS.identifier(ident));
    });
  });
  const expr = genExpr(ast, typesMap, env2);

  switch (idents.length) {
    case 0:
      return expr;

    case 1:
      // ${signal}.map({$ident} => expr)
      return (
        JS.callExpression(
          JS.memberExpression(signals[0], JS.identifier('map')),
          [
            JS.arrowFunctionExpression(
              [ JS.identifier(idents[0]) ],
              expr
            )
          ]
        )
      );

    default:
      // Signal.join(...${signals}).map(([...${idents}]) => ${expr})
      return (
        JS.callExpression(
          JS.memberExpression(
            JS.callExpression(
              JS.memberExpression(JS.identifier('Signal'), JS.identifier('join')),
              signals
            ),
            JS.identifier('map'),
          ),
          [
            JS.arrowFunctionExpression(
              [ JS.arrayPattern(idents.map(ident => JS.identifier(ident))) ],
              expr,
            )
          ]
        )
      );
  }
}

function isDynamic(
  ast: ESTree.Expression,
  dynamicEnv: Render.DynamicEnv
): boolean {
  return ESTree.freeIdentifiers(ast).some(ident => {
    const dynamic = dynamicEnv.get(ident) ?? bug(`expected dynamic`);
    return dynamic
  });
}

function genNode(
  node: PMAST.Node,
  parsedCode: (code: PMAST.Node) => Try<ESTree.Node>,
  typesMap: (e: ESTree.Expression) => Type,
  dynamicEnv: Render.DynamicEnv,
  valueEnv: Map<string, JS.Expression>,
  decls: JS.Statement[],
  hydrates: JS.Statement[],
): void {
  const hydrate = (e: ESTree.Expression) => {
    // ReactDOM.hydrate(Signal.node(expr), document.getElementById(id))
    hydrates.push(
      JS.expressionStatement(
        JS.callExpression(
          JS.memberExpression(JS.identifier('ReactDOM'), JS.identifier('hydrate')),
          [
            JS.callExpression(
              JS.memberExpression(JS.identifier('Signal'), JS.identifier('node')),
              [ genDynamicExpr(e, typesMap, dynamicEnv, valueEnv) ]
            ),
            JS.callExpression(
              JS.memberExpression(JS.identifier('document'), JS.identifier('getElementById')),
              [ JS.stringLiteral(`__root${hydrates.length}`) ]
            )
          ]
        )
      )
    );
  }

  if (PMAST.isCode(node)) {
    const ast = parsedCode(node);
    if (ast.type === 'ok') {
      for (const node of (ast.ok as ESTree.Program).body) {
        switch (node.type) {
          case 'ExpressionStatement': {
            const type = typesMap(node.expression);
            if (type.kind !== 'Error' && isDynamic(node.expression, dynamicEnv)) {
              hydrate(node.expression);
            }
          }
          break;

          // TODO(jaked) do this as a separate pass maybe
          case 'VariableDeclaration': {
            switch (node.kind) {
              case 'const': {
                for (const declarator of node.declarations) {
                  if (!declarator.init) return;
                  const name = declarator.id.name;
                  const init =
                    genDynamicExpr(declarator.init, typesMap, dynamicEnv, valueEnv);
                  decls.push(JS.variableDeclaration('const', [
                    JS.variableDeclarator(JS.identifier(name), init)
                  ]));
                }
              }
            }
            break;
          }

          case 'ImportDeclaration':
            // TODO(jaked)
            break;

          default:
            bug(`unimplemented ${node.type}`);
        }
      }
    }

  } else if (PMAST.isInlineCode(node)) {
    const ast = parsedCode(node);
    if (ast.type === 'ok') {
      const expr = ast.ok as ESTree.Expression;
      const type = typesMap(expr);
      if (type.kind !== 'Error' && isDynamic(expr, dynamicEnv)) {
        hydrate(expr);
      }
    }

  } else if (PMAST.isElement(node)) {
    node.children.forEach(child => genNode(child, parsedCode, typesMap, dynamicEnv, valueEnv, decls, hydrates));
  }
}

export function generatePm(
  nodes: PMAST.Node[],
  parsedCode: (code: PMAST.Node) => Try<ESTree.Node>,
  typesMap: (e: ESTree.Expression) => Type,
  dynamicEnv: Render.DynamicEnv,
) {
  const decls: JS.Statement[] = [];
  const hydrates: JS.Statement[] = [];
  const valueEnv = new Map<string, JS.Expression>([
    ['now', JS.memberExpression(JS.identifier('Runtime'), JS.identifier('now'))],
    ['mouse', JS.memberExpression(JS.identifier('Runtime'), JS.identifier('mouse'))],
    ['Math', JS.identifier('Math')]
  ]);
  nodes.forEach(node => genNode(node, parsedCode, typesMap, dynamicEnv, valueEnv, decls, hydrates));

  // TODO(jaked)
  // don't generate imports / bindings
  // unless they are referenced via a dynamic element or an export
  if (decls.length === 0 && hydrates.length === 0)
    return '';

  const declsText = babelGenerator(JS.program(decls)).code;
  const hydratesText = babelGenerator(JS.program(hydrates)).code;

  // TODO(jaked) can we use symbols instead of __ids to avoid collisions?
  return `
import React from 'https://cdn.skypack.dev/pin/react@v17.0.1-yH0aYV1FOvoIPeKBbHxg/mode=imports/optimized/react.js';
import ReactDOM from 'https://cdn.skypack.dev/pin/react-dom@v17.0.1-N7YTiyGWtBI97HFLtv0f/mode=imports/optimized/react-dom.js';
import Signal from '/__runtime/Signal.js';
import * as Runtime from '/__runtime/Runtime.js';

const __e = (el, props, ...children) => React.createElement(el, props, ...children)

${declsText}
${hydratesText}
`;
}
