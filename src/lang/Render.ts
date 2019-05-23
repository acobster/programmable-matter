import * as Immutable from 'immutable';

import * as React from 'react';

import 'regenerator-runtime/runtime'; // required for react-inspector
import { Inspector } from 'react-inspector';

import { TwitterTweetEmbed } from 'react-twitter-embed';
import YouTube from 'react-youtube';
import { VictoryBar } from 'victory';
import ReactTable from 'react-table'

import { InlineMath, BlockMath } from 'react-katex';

import { Atom, F, Lens, ReadOnlyAtom } from '@grammarly/focal';
import * as Focal from '@grammarly/focal';

import * as MDXHAST from './mdxhast';
import * as AcornJsxAst from './acornJsxAst';
import * as Evaluator from './evaluator';
import * as Type from './Type';
import * as Typecheck from './Typecheck';

const STARTS_WITH_CAPITAL_LETTER = /^[A-Z]/

type State = Atom<Immutable.Map<string, any>>;
export type Env = Immutable.Map<string, any>;

function immutableMapLens<T>(key: string): Lens<Immutable.Map<string, T>, T> {
  return Lens.create(
    (map: Immutable.Map<string, T>) => map.get<any>(key, null),
    (t: T, map: Immutable.Map<string, T>) => map.set(key, t)
  )
}

function renderExpression(ast: AcornJsxAst.Expression, env: Env) {
  const names = new Set<string>();
  const evaluatedAst =
    Evaluator.evaluateExpression(ast,
      {
        mode: 'compile',
        names,
        renderJsxElement: (ast) => renderJsx(ast, env)
      }
    );
  if (evaluatedAst.type === 'Literal') {
    return evaluatedAst.value;
  } else {
    // TODO(jaked) how do I map over a Set to get an array?
    const atoms: Array<ReadOnlyAtom<any>> = [];
    names.forEach(name => {
      if (env.has(name)) {
        let value = env.get(name);
        // TODO(jaked) hack
        // we assume that any identifier refers to an Atom
        // but we evaluate constant expressions to a non-Atom value
        // and we can't combine non-Atoms
        // (scalars fail, arrays become multiple observations)
        // a better way to handle it would be to track this in typechecking
        if (!/Atom/.test(value.constructor.name))
          value = Atom.create(value)
        atoms.push(value);
      } else {
        throw 'expected binding for ' + name;
      }
    });
    const combineFn = function (...values: Array<any>) {
      const env = new Map<string, any>();
      let i = 0;
      names.forEach(name => env.set(name, values[i++]));
      const evaluatedAst2 =
        Evaluator.evaluateExpression(evaluatedAst, { mode: 'run', env: env });
      if (evaluatedAst2.type === 'Literal') {
        return evaluatedAst2.value;
      } else {
        throw 'expected fully-evaluated expression';
      }
    }
    // TODO(jaked) it doesn't seem to be possible to call the N-arg version of combine,
    // even though all the K-arg versions are alternate signatures for it.
    const combine = Atom.combine as (...args: any) => ReadOnlyAtom<any>;
    return combine(...[...atoms, combineFn]);
  }
}

function renderAttributes(attributes: Array<AcornJsxAst.JSXAttribute>, env: Env) {
  const attrObjs = attributes.map(({ name, value }) => {
    let attrValue;
    switch (value.type) {
      case 'JSXExpressionContainer':
        attrValue = renderExpression(value.expression, env);
        break;
      case 'Literal':
        attrValue = value.value;
        break;
      default:
        throw 'unexpected AST ' + (value as any).type;
    }
    return { [name.name]: attrValue };
  });
  return Object.assign({}, ...attrObjs);
}

const components = new Map([
  [ 'Inspector', Inspector ],
  [ 'Tweet', TwitterTweetEmbed ],
  [ 'YouTube', YouTube ],
  [ 'VictoryBar', VictoryBar ],
  [ 'InlineMath', InlineMath ],
  [ 'BlockMath', BlockMath ],
  [ 'Table', ReactTable ]
].map(([name, comp]) => [name, Focal.lift(comp)]));

function renderElement(name: string) {
  if (STARTS_WITH_CAPITAL_LETTER.test(name)) {
    const comp = components.get(name)
    if (comp) return comp;
    else throw 'unexpected element ' + name;
  } else {
    return F[name] || name;
  }
}

function renderJsx(ast: AcornJsxAst.JSXElement, env: Env): React.ReactNode {
  const attrs = renderAttributes(ast.openingElement.attributes, env);
  const elem = renderElement(ast.openingElement.name.name);
  const children = ast.children.map(child => {
    switch (child.type) {
      case 'JSXElement':
        return renderJsx(child, env);
      case 'JSXText':
        return child.value;
      case 'JSXExpressionContainer':
        return renderExpression(child.expression, env);
    }
  });

  // TODO(jaked) for what elements does this make sense? only input?
  if (attrs.id) {
    if (env.has(attrs.id)) {
      const atom = env.get(attrs.id) as Atom<any>;
      attrs.onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        atom.set(e.currentTarget.value);
      }
    } else {
      // TODO(jaked) check statically
      // also check that it is a non-readonly Atom
      throw 'unbound identifier ' + attrs.id;
    }
  }

  return React.createElement(elem, attrs, ...children);
}

function evaluateMdxBindings(
  ast: MDXHAST.Node,
  env: Env,
  state: State,
  exportValues: { [s: string]: any }
): Env {
  switch (ast.type) {
    case 'root':
    case 'element':
      ast.children.forEach(child =>
        env = evaluateMdxBindings(child, env, state, exportValues)
      );
      return env;

    case 'text':
    case 'jsx':
      return env;

    case 'import':
      // TODO(jaked)
      return env;

    case 'export': {
      if (!ast.exportNamedDeclaration) throw 'expected export node to be parsed';
      const declaration = ast.exportNamedDeclaration.declaration;
      const declarator = declaration.declarations[0]; // TODO(jaked) handle multiple
      switch (declaration.kind) {
        case 'const': {
          let name = declarator.id.name;
          let value = renderExpression(declarator.init, env);
          exportValues[name] = value;
          return env.set(name, value);
        }

        case 'let': {
          const evaluatedAst =
            Evaluator.evaluateExpression(declarator.init,
              {
                mode: 'compile',
                names: new Set<string>(),
                // TODO(jaked) check this statically
                renderJsxElement: (ast) => { throw 'JSX element may not appear in atom declaration' }
              }
            );
          if (evaluatedAst.type === 'Literal') {
            const name = declarator.id.name;
            const value = state.lens(immutableMapLens(name));
            if (value.get() === null) {
              value.set(evaluatedAst.value);
            }
            exportValues[name] = value;
            return env.set(name, value);
          } else {
            // TODO(jaked) check this statically
            throw 'atom initializer must be static';
          }
        }
      }
    }

    default: throw 'unexpected AST ' + (ast as MDXHAST.Node).type;
  }
}

function renderMdxElements(ast: MDXHAST.Node, env: Env): React.ReactNode {
  switch (ast.type) {
    case 'root':
      return React.createElement(
        'div',
        {},
        ...ast.children.map(child => renderMdxElements(child, env))
      );

    case 'element':
      return React.createElement(
        ast.tagName,
        ast.properties,
        ...ast.children.map(child => renderMdxElements(child, env))
      );

    case 'text':
      // TODO(jaked) handle interpolation
      return ast.value;

    case 'jsx':
      if (ast.jsxElement) {
        return renderJsx(ast.jsxElement, env);
      } else {
        throw 'expected JSX node to be parsed';
      }

    case 'import':
    case 'export':
      return undefined;

    default: throw 'unexpected AST ' + (ast as MDXHAST.Node).type;
  }
}

export function renderMdx(
  ast: MDXHAST.Node,
  env: Env,
  state: State,
  exportValues: { [s: string]: any }
): React.ReactNode {
  const env2 = evaluateMdxBindings(ast, env, state, exportValues);
  return renderMdxElements(ast, env2);
}

// TODO(jaked) full types for components
// TODO(jaked) types for HTML elements
export const initEnv: Typecheck.Env = Immutable.Map({
  'Tweet': Type.object({ tweetId: Type.string }),
  'YouTube': Type.object({ videoId: Type.string }),

  'VictoryBar': Type.object({}),
  'Inspector': Type.object({}),

  'Table': Type.object({
    data: Type.array(Type.object({})),
    // TODO(jaked)
    // column accessor types depend on data type (for Victory too)
    // can we express this with a type parameter?
    columns: Type.array(Type.object({
      Header: Type.string,
      accessor: Type.string,
    })),
    pageSize: Type.number,
  }),
});
