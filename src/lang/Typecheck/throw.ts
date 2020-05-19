import Recast from 'recast/main';

import Try from '../../util/Try';
import Type from '../Type';
import * as ESTree from '../ESTree';
import { AstAnnotations } from '../../data';

class LocatedError extends Error {
  location: ESTree.Node;

  constructor(msg: string, location: ESTree.Node) {
    super(msg);
    this.location = location;
  }

  toString() {
    return this.message + ' at ' + Recast.print(this.location).code;
  }
}

export function withLocation(ast: ESTree.Node, msg, annots?: AstAnnotations): never {
  const err = new LocatedError(msg, ast);
  if (annots) annots.set(ast, Try.err(err));
  throw err;
}

export function expectedType(
  ast: ESTree.Node,
  expected: string | Type,
  actual?: string | Type,
  annots?: AstAnnotations
): never {
  if (typeof expected !== 'string')
    expected = Type.toString(expected);
  if (actual && typeof actual !== 'string')
    actual = Type.toString(actual);

  let msg = 'expected ' + expected;
  if (actual) msg += ', got ' + actual;
  return withLocation(ast, msg, annots);
}

export function unknownField(
  ast: ESTree.Node,
  field: string,
  annots?: AstAnnotations
): never {
  return withLocation(ast, `unknown field '${field}'`, annots);
}

export function missingField(
  ast: ESTree.Node,
  field: string,
  annots?: AstAnnotations
): never {
  return withLocation(ast, `missing field '${field}'`, annots);
}

export function extraField(
  ast: ESTree.Node,
  field: string,
  annots?: AstAnnotations
): never {
  return withLocation(ast, `extra field ${field}`, annots);
}

export function wrongArgsLength(
  ast: ESTree.Node,
  expected: number,
  actual: number,
  annots?: AstAnnotations
) {
  return withLocation(ast, `expected ${expected} args, function has ${actual} args`, annots);
}

export function wrongParamsLength(
  ast: ESTree.Node,
  expected: number,
  actual: number,
  annots?: AstAnnotations
) {
  return withLocation(ast, `expected ${expected} type params, got ${actual} params`, annots);
}

export function duplicateIdentifier(
  ast: ESTree.Node,
  ident: string,
  annots?: AstAnnotations
): never {
  return withLocation(ast, `duplicate identifier ${ident}`, annots);
}
