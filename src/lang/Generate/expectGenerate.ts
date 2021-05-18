import * as Immutable from 'immutable';
import * as JS from '@babel/types';
import babelGenerator from '@babel/generator';

import { Interface } from '../../model';
import * as ESTree from '../ESTree';
import Type from '../Type';
import * as Parse from '../Parse';
import Typecheck from '../Typecheck';
import * as Generate from './index';
import Signal from '../../util/Signal';
import { bug } from '../../util/bug';

// TODO(jaked)
// seems like TS should be able to figure it out from the instanceof
function isTEnv(env: any): env is Typecheck.Env {
  return env instanceof Immutable.Map;
}

export default function expectGenerate({ expr, tenv, venv, value } : {
  expr: ESTree.Expression | string,
  value: any,
  tenv?: Typecheck.Env | { [s: string]: string | Type | Interface },
  venv?: Map<string, unknown> | { [s: string]: unknown },
}) {
  expr = (typeof expr === 'string') ? Parse.parseExpression(expr) : expr;
  tenv = tenv ?
    (isTEnv(tenv) ?
      tenv :
      Typecheck.env(tenv as any)) :
    Typecheck.env();
  venv = venv ?
    (venv instanceof Map ?
      venv :
      (new Map(Object.entries(venv)))) :
    (new Map());
  const interfaceMap = new Map<ESTree.Node, Interface>();
  Typecheck.synth(expr, tenv, interfaceMap);

  const jsExpr = Generate.expression(
    expr,
    expr => interfaceMap.get(expr) ?? bug(`expected interface for ${JSON.stringify(expr)}`),
    new Map()
  );
  const fn = new Function(...venv.keys(), babelGenerator(
    JS.program([
      JS.returnStatement(jsExpr)
    ])
  ).code);

  let actual = fn(...venv.values());
  const intf = interfaceMap.get(expr) ?? bug(`expected interface`);
  if (intf.type === 'ok' && intf.ok.dynamic) {
    actual = (actual as Signal<unknown>).get();
  }

  expect(actual).toEqual(value);
}
