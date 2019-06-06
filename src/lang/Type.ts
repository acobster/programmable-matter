import * as Equals from '../util/equals';

export type NeverType = { kind: 'never' };
export type UnknownType = { kind: 'unknown' };
export type UndefinedType = { kind: 'undefined' };
export type NullType = { kind: 'null' };
export type BooleanType = { kind: 'boolean' };
export type NumberType = { kind: 'number' };
export type StringType = { kind: 'string' };
export type TupleType = { kind: 'Tuple', elems: Array<Type> };
export type ArrayType = { kind: 'Array', elem: Type };
export type SetType = { kind: 'Set', elem: Type };
export type MapType = { kind: 'Map', key: Type, value: Type };

// invariant: no duplicate fields
export type ObjectType = { kind: 'Object', fields: Array<{ field: string, type: Type }> };

// invariant: no duplicate fields
export type ModuleType = { kind: 'Module', fields: Array<{ field: string, type: Type, atom: boolean }> };

// invariant: no nested unions, > 1 element
export type UnionType = { kind: 'Union', types: Array<Type> };

// invariant: no nested intersections, > 1 element
export type IntersectionType = { kind: 'Intersection', types: Array<Type> };

// invariant: `value` is a valid (JS-level) element of base type
export type SingletonType = { kind: 'Singleton', base: Type, value: any };

export type Type =
  NeverType |
  UnknownType |
  UndefinedType |
  NullType |
  BooleanType |
  NumberType |
  StringType |
  TupleType |
  ArrayType |
  SetType |
  MapType |
  ObjectType |
  ModuleType |
  UnionType |
  IntersectionType |
  SingletonType;

export const never: NeverType = { kind: 'never' };
export const unknown: UnknownType = { kind: 'unknown' };
export const undefinedType: UndefinedType = { kind: 'undefined' };
export { undefinedType as undefined };
export const nullType: NullType = { kind: 'null' };
export { nullType as null };
export const booleanType: BooleanType = { kind: 'boolean' };
export { booleanType as boolean };
export const numberType: NumberType = { kind: 'number' };
export { numberType as number };
export const stringType: StringType = { kind: 'string' };
export { stringType as string };

export function tuple(...elems: Array<Type>): TupleType {
  return { kind: 'Tuple', elems };
}

export function array(elem: Type): ArrayType {
  return { kind: 'Array', elem };
}

export function set(elem: Type): SetType {
  return { kind: 'Set', elem };
}

export function map(key: Type, value: Type): MapType {
  return { kind: 'Map', key, value };
}

export function object(obj: { [f: string]: Type }): ObjectType {
  const fields =
    Object.entries(obj).map(([ field, type]) => ({ field, type }));
  return { kind: 'Object', fields };
}

export function module(obj: { [f: string]: [Type, boolean] }): ModuleType {
  const fields =
    Object.entries(obj).map(([ field, [ type, atom ]]) => ({ field, type, atom }));
  return { kind: 'Module', fields };
}

export function singleton(base: BooleanType, value: boolean): SingletonType
export function singleton(base: NumberType, value: number): SingletonType
export function singleton(base: StringType, value: string): SingletonType
export function singleton(base: Type, value: any): SingletonType {
 return { kind: 'Singleton', base, value };
}

// TODO(jaked) find a library for these
function uniq(xs: Array<Type>): Array<Type> {
  const accum: Array<Type> = [];
  xs.forEach(x => {
    if (accum.every(y => !equiv(x, y)))
      accum.push(x)
  });
  return accum;
}

export function union(...types: Array<Type>): Type {
  function flatten(types: Array<Type>, accum: Array<Type> = []): Array<Type> {
    types.forEach(t => {
      if (t.kind === 'Union') return flatten(t.types, accum);
      else accum.push(t);
    });
    return accum;
  }

  const arms = uniq(flatten(types));
  switch (arms.length) {
    case 0: return never;
    case 1: return arms[0];
    default: return { kind: 'Union', types: arms };
  }
}

export function intersection(...types: Array<Type>): Type {
  function flatten(types: Array<Type>, accum: Array<Type> = []): Array<Type> {
    types.forEach(t => {
      if (t.kind === 'Intersection') return flatten(t.types, accum);
      else accum.push(t);
    });
    return accum;
  }

  const arms = uniq(flatten(types));
  switch (arms.length) {
    case 0: return unknown;
    case 1: return arms[0];
    default: return { kind: 'Intersection', types: arms };
  }
}

export function leastUpperBound(...types: Array<Type>): Type {
  switch (types.length) {
    case 0: return never;
    case 1: return types[0];

    case 2:
      return union(...types);

    default:
      const lub =
        leastUpperBound(
          leastUpperBound(types[0], types[1]),
          ...types.slice(undefined, -2)
        );
      return lub;
  }
}

export function equiv(a: Type, b: Type): boolean {
  return isSubtype(a, b) && isSubtype(b, a);
}

export function isSubtype(a: Type, b: Type): boolean {
  if (Equals.equals(a, b)) return true;
  else if (a.kind === 'never') return true;
  else if (b.kind === 'unknown') return true;
  else if (a.kind === 'Union') return a.types.every(t => isSubtype(t, b));
  else if (b.kind === 'Union') return b.types.some(t => isSubtype(a, t));
  else if (a.kind === 'Singleton' && b.kind === 'Singleton')
    return isSubtype(a.base, b.base) && Equals.equals(a.value, b.value);
  else if (a.kind === 'Singleton')
    return isSubtype(a.base, b);
  else if (a.kind === 'Array' && b.kind === 'Array')
    return isSubtype(a.elem, b.elem);
  else if (a.kind === 'Set' && b.kind === 'Set')
    return isSubtype(a.elem, b.elem);
  else if (a.kind === 'Map' && b.kind === 'Map')
    return isSubtype(b.key, a.key) && isSubtype(a.value, b.value);
  else if (a.kind === 'Tuple' && b.kind === 'Tuple')
    return a.elems.length === b.elems.length &&
      a.elems.every((t, i) => isSubtype(t, b.elems[i]));
  else if (a.kind === 'Object' && b.kind === 'Object') {
    const fieldTypes = new Map(a.fields.map(({ field, type }) => [field, type]));
    return b.fields.every((ft) => {
      const a = fieldTypes.get(ft.field);
      if (a) return isSubtype(a, ft.type);
      else return false;
    });
  }
  else return false;
}
