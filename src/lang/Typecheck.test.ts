import * as Immutable from 'immutable';
import * as ESTree from './ESTree';
import * as Parser from './Parser';
import * as Type from './Type';
import * as Typecheck from './Typecheck';

describe('check', () => {
  function expectCheckThrows(
    exprOrString: ESTree.Expression | string,
    type: Type.Type,
    env: Typecheck.Env = Immutable.Map()
  ) {
    const expr =
      (typeof exprOrString === 'string') ? Parser.parseExpression(exprOrString)
      : exprOrString;
    expect(() => Typecheck.check(expr, env, type)).toThrow();
  }

  function expectCheck(
    exprOrString: ESTree.Expression | string,
    type: Type.Type,
    env: Typecheck.Env = Immutable.Map()
  ) {
    const expr =
      (typeof exprOrString === 'string') ? Parser.parseExpression(exprOrString)
      : exprOrString;
    expect(Typecheck.check(expr, env, type)).toBe(undefined);
  }

  describe('primitives', () => {
    describe('literals', () => {
      it('succeeds', () => {
        expectCheck('7', Type.number);
      });

      it('throws', () => {
        expectCheckThrows('7', Type.string);
      });
    });

    it('identifiers', () => {
      const env: Typecheck.Env = Immutable.Map({ foo: Type.boolean });
      expectCheck('foo', Type.boolean, env);
    });
  });

  describe('tuples', () => {
    const type = Type.tuple(Type.number, Type.boolean, Type.null);

    describe('literals', () => {
      it('succeeds', () => {
        expectCheck('[1, true, null]', type);
      });

      it ('throws', () => {
        expectCheckThrows('[1, "foo", null]', type)
      });
    });

    it('identifiers', () => {
      const env: Typecheck.Env =  Immutable.Map({ foo: type });
      expectCheck('foo', type, env)
    });

    it ('throws on long tuples', () => {
      expectCheckThrows('[1, "foo", null, 1]', type)
    });
  });

  describe('arrays', () => {
    const type = Type.array(Type.number);

    describe('literals', () => {
      it('succeeds', () => {
        expectCheck('[1, 2, 3]', type);
      });

      it('throws', () => {
        expectCheckThrows('[1, true]', type);
      });
    });

    it('identifiers', () => {
      const env: Typecheck.Env =  Immutable.Map({ foo: type });
      expectCheck('foo', type, env);
    });
  });

  describe('objects', () => {
    const type = Type.object({ bar: Type.undefinedOrNumber });

    it('undefined properties may be omitted', () => {
      expectCheck('({ })', type);
    });

    it('throws on excess properties in literals', () => {
      expectCheckThrows('({ foo: 7 })', type);
    });

    it('permits excess properties in non-literal', () => {
      const env: Typecheck.Env = Immutable.Map({
        foo: Type.object({ baz: Type.number }),
      });
      expectCheck('foo', type, env);
    });
  });

  describe('function expressions', () => {
    const type =
      Type.function(
        [ Type.number ],
        Type.number
      );

    it('ok', () => {
      expectCheck('x => x + 7', type);
    });

    it('wrong arg count', () => {
      expectCheckThrows('(x, y) => x + y', type);
    });

    it('wrong body type', () => {
      expectCheckThrows(`x => 'foo'`, type);
    });
  });

  describe('singletons', () => {
    const type = Type.singleton(7);

    it('succeeds', () => {
      expectCheck('7', type);
    });

    it('throws', () => {
      expectCheckThrows('8', type);
    });
  });

  describe('unions', () => {
    const type = Type.union(Type.boolean, Type.number);

    it('succeeds', () => {
      expectCheck('true', type);
      expectCheck('7', type);
    });

    it('throws', () => {
      expectCheckThrows('"foo"', type);
    });

    it('union inside array', () => {
      const type = Type.array(Type.union(Type.boolean, Type.number));
      expectCheck('[ false, 7 ]', type);
    });
  });

  describe('intersections', () => {
    const type = Type.intersection(
      Type.array(Type.number),
      Type.array(Type.singleton(7))
    );

    it('succeeds', () => {
      expectCheck('[ 7 ]', type);
    });

    it('throws', () => {
      expectCheckThrows('[ 9 ]', type);
    });

    it('succeeds for a uniform function', () => {
      const type = Type.intersection(
        Type.function([ Type.number ], Type.number),
        Type.function([ Type.string ], Type.string),
      );
      expectCheck('x => x', type);
    });

    it('succeeds for a non-uniform function', () => {
      const type = Type.intersection(
        Type.function([ Type.singleton('number') ], Type.number),
        Type.function([ Type.singleton('string') ], Type.string),
      );
      expectCheck(`x => x === 'number' ? 7 : 'nine'`, type);
    });
  });

  describe('conditional expressions', () => {
    it('ok', () => {
      const env: Typecheck.Env =
        Immutable.Map({ b: Type.boolean });
      expectCheck('b ? 1 : 2', Type.enumerate(1, 2), env);
    });

    it('ok with statically evaluable test', () => {
      expectCheck('true ? 1 : 2', Type.singleton(1));
    });

    it('ok with statically evaluable test 2', () => {
      const env: Typecheck.Env =
        Immutable.Map({ x: Type.singleton('foo') });
      expectCheck(`x === 'foo' ? 1 : 2`, Type.singleton(1), env);
    });

    it('narrows type for equality tests', () => {
      const env: Typecheck.Env =
        Immutable.Map({ s: Type.enumerate('foo', 'bar') });
      expectCheck(`s === 'foo' ? s : 'foo'`, Type.singleton('foo'), env);
    });
  });
});

describe('synth', () => {
  function expectSynthThrows(
    exprOrString: ESTree.Expression | string,
    env: Typecheck.Env = Immutable.Map()
  ) {
    const expr =
      (typeof exprOrString === 'string') ? Parser.parseExpression(exprOrString)
      : exprOrString;
    expect(() => Typecheck.synth(expr, env)).toThrow();
  }

  function expectSynth(
    exprOrString: ESTree.Expression | string,
    type: Type.Type,
    env: Typecheck.Env = Immutable.Map()
  ) {
    const expr =
      (typeof exprOrString === 'string') ? Parser.parseExpression(exprOrString)
      : exprOrString;
    expect(Typecheck.synth(expr, env)).toEqual(type);
  }

  describe('identifiers', () => {
    it('succeeds', () => {
      const env: Typecheck.Env = Immutable.Map({ foo: Type.boolean });
      expectSynth('foo', Type.boolean, env);
    });

    it('throws', () => {
      expectSynthThrows('foo');
    });
  });

  describe('literals', () => {
    it('boolean', () => {
      expectSynth('true', Type.singleton(true));
    });

    it('string', () => {
      expectSynth('"foo"', Type.singleton("foo"));
    });

    it('null', () => {
      expectSynth('null', Type.null);
    });
  });

  describe('arrays', () => {
    it('uniform', () => {
      // Typescript synths Array<number> here
      const type = Type.array(Type.union(
        Type.singleton(7),
        Type.singleton(9)
      ));
      expectSynth('[ 7, 9 ]', type);
    });

    it('non-uniform', () => {
      // Typescript synths Array<number | boolean> here
      const type = Type.array(Type.union(
        Type.singleton(7),
        Type.singleton(true)
      ));
      expectSynth('[ 7, true ]', type);
    });
  });

  describe('objects', () => {
    it('succeeds', () => {
      const type = Type.object({
        foo: Type.singleton(7),
        bar: Type.singleton(true)
      });
      expectSynth('({ foo: 7, bar: true })', type);
    });

    it('throws', () => {
      // object with duplicate field names is invalid
      expectSynthThrows('({ foo: 7, foo: 9 })');
    });
  });

  describe('unary expressions', () => {
    it('!', () => {
      expectSynth('!7', Type.singleton(false));
    });

    it('typeof', () => {
      expectSynth('typeof 7', Type.singleton('number'));
    });
  });

  describe('logical expressions', () => {
    describe('statically evaluated', () => {
      it('&& truthy', () => {
        expectSynth('"foo" && 7', Type.singleton(7));
      });

      it('&& falsy', () => {
        expectSynth('0 && "foo"', Type.singleton(0));
      });

      it('|| truthy', () => {
        expectSynth('"foo" || 7', Type.singleton("foo"));
      });

      it('|| falsy', () => {
        expectSynth('"" || 0', Type.singleton(0));
      });
    });

    describe('not statically evaluated', () => {
      const env: Typecheck.Env = Immutable.Map({
        number: Type.number,
        string: Type.string,
      });

      it('&&', () => {
        expectSynth(
          'number && string',
          Type.union(Type.singleton(0), Type.string),
          env
        );
      });

      it('||', () => {
        expectSynth(
          'number || string',
          Type.union(Type.number, Type.string),
          env
        );
      });
    });
  });

  describe('binary expressions', () => {
    describe('statically evaluated', () => {
      it('+ numbers', () => {
        expectSynth('1 + 2', Type.singleton(3));
      });

      it('+ strings', () => {
        expectSynth('"foo" + "bar"', Type.singleton('foobar'));
      });

      it('===', () => {
        expectSynth('"foo" === "bar"', Type.singleton(false));
      });

      it('!==', () => {
        expectSynth('"foo" !== "bar"', Type.singleton(true));
      });
    });

    describe('not statically evaluated', () => {
      const env: Typecheck.Env = Immutable.Map({
        number: Type.number,
        string: Type.string,
      });

      it('+ numbers', () => {
        expectSynth('number + number', Type.number, env);
      });

      it('+ strings', () => {
        expectSynth('string + string', Type.string, env);
      });

      it('===', () => {
        expectSynth('string === string', Type.boolean, env);
      });

      it('!==', () => {
        expectSynth('string !== string', Type.boolean, env);
      });
    });
  });

  describe('member expressions', () => {
    const env: Typecheck.Env = Immutable.Map({
      object: Type.object({ foo: Type.boolean, bar: Type.number }),
      array: Type.array(Type.number),
      tuple: Type.tuple(Type.boolean, Type.number),
      numberUnion: Type.union(
        Type.singleton(0),
        Type.singleton(1),
      ),
      stringUnion: Type.union(
        Type.singleton('foo'),
        Type.singleton('bar'),
      ),
    });

    it('property names', () => {
      expectSynth('object.foo', Type.boolean, env);
    });

    it('string index', () => {
      expectSynth('object["foo"]', Type.boolean, env);
    });

    it('number index in array', () => {
      expectSynth('array[0]', Type.number, env);
    });

    it('number index in tuple', () => {
      expectSynth('tuple[0]', Type.boolean, env);
    });

    it('multiple number indexes in tuple', () => {
      expectSynth('tuple[numberUnion]', Type.union(Type.boolean, Type.number), env);
    });

    it('multiple string indexes in object', () => {
      expectSynth('object[stringUnion]', Type.union(Type.boolean, Type.number), env);
    });

    it('throws on string index to array', () => {
      expectSynthThrows('array["xyzzy"]');
    });

    it('throws on tuple index out of range', () => {
      expectSynthThrows('tuple[2]');
    });

    it('throws on unknown object index', () => {
      expectSynthThrows('object["quux"]');
    });

    it('throws on unknown object property', () => {
      expectSynthThrows('object.quux');
    });
  });

  describe('function expressions', () => {
    it('ok', () => {
      expectSynth(
        '() => 7',
        Type.function([], Type.singleton(7))
      );
    });

    it('ok with params', () => {
      expectSynth(
        '(x: number, y: 7) => x + y',
        Type.function(
          [ Type.number, Type.singleton(7) ],
          Type.number
        )
      );
    });
  });

  describe('function calls', () => {
    const env: Typecheck.Env = Immutable.Map({
      f: Type.function([ Type.number ], Type.string),
      intf: Type.intersection(
        Type.function([ Type.number ], Type.number),
        Type.function([ Type.string ], Type.string),
      ),
      intx: Type.intersection(Type.number, Type.string),
    });

    it('ok', () => {
      expectSynth('f(7)', Type.string, env);
    });

    it('ok intersection', () => {
      expectSynth(`intf(7)`, Type.number, env);
      expectSynth(`intf('nine')`, Type.string, env);
      expectSynth(`intf(intx)`, Type.never, env)
    });

    it('throws when callee is not a function', () => {
      expectSynthThrows('7(9)');
    });

    it('throws when not enough args', () => {
      expectSynthThrows('f()');
    });

    it('throws when too many args', () => {
      expectSynthThrows('f(7, 9)');
    });

    it('throws when arg is wrong type', () => {
      expectSynthThrows('f("seven")');
    });
  });

  describe('JSX elements', () => {
    const env: Typecheck.Env = Immutable.Map({
      Component: Type.function(
        [ Type.object({ foo: Type.number, bar: Type.undefinedOrNumber }) ],
        Type.string
      ),
      NotFunction: Type.string,
      TooManyParams: Type.function([ Type.string, Type.number ], Type.boolean),
      ParamNotObject: Type.function([ Type.string ], Type.boolean),
      WrongChildrenType: Type.function([ Type.object({ children: Type.number }) ], Type.boolean),
    });

    it('ok', () => {
      // bar may be omitted because the type may be undefined
      expectSynth('<Component foo={7} />', Type.string, env);
    });

    it('throws when prop is missing', () => {
      expectSynthThrows('<Component />', env);
    });

    it('throws when prop has wrong type', () => {
      expectSynthThrows('<Component foo={"bar"} />', env);
    });

    it('throws when not a function', () => {
      expectSynthThrows('<NotFunction />', env);
    });

    it('throws when too many params', () => {
      expectSynthThrows('<TooManyParams />', env);
    });

    it('throws when param is not an object', () => {
      expectSynthThrows('<ParamNotObject />', env);
    });

    it('throws when wrong children type', () => {
      expectSynthThrows('<WrongChildrenType />', env);
    });
  });

  describe('conditional expressions', () => {
    it('ok', () => {
      const env: Typecheck.Env =
        Immutable.Map({ b: Type.boolean });
      expectSynth('b ? 1 : 2', Type.enumerate(1, 2), env);
    });

    it('ok with statically evaluable test', () => {
      expectSynth('true ? 1 : 2', Type.singleton(1));
    });

    it('ok with statically evaluable test 2', () => {
      const env: Typecheck.Env =
        Immutable.Map({ x: Type.singleton('foo') });
      expectSynth(`x === 'foo' ? 1 : 2`, Type.singleton(1), env);
    });

    it('narrows type for equality tests', () => {
      const env: Typecheck.Env =
        Immutable.Map({ s: Type.enumerate('foo', 'bar') });
      expectSynth(`s === 'foo' ? s : 'foo'`, Type.singleton('foo'), env);
    });

    it('narrows type for false branch of equality tests', () => {
      const env: Typecheck.Env =
        Immutable.Map({ s: Type.enumerate('foo', 'bar') });
      expectSynth(`s === 'foo' ? 'bar' : s`, Type.singleton('bar'), env);
    });

    it('narrows type via member expressions', () => {
      const env: Typecheck.Env =
        Immutable.Map({ s: Type.union(
          Type.object({ type: Type.singleton('foo'), foo: Type.number }),
          Type.object({ type: Type.singleton('bar'), bar: Type.number }),
        ) });
      expectSynth(`s.type === 'foo' ? s.foo : s.bar`, Type.number, env);
    });

    it('narrows type for truthiness tests', () => {
      const env: Typecheck.Env =
        Immutable.Map({ s: Type.union(Type.number, Type.undefined) });
      expectSynth(`s ? s : 7`, Type.number, env);
    });

    it('narrows type for falsiness tests', () => {
      const env: Typecheck.Env =
        Immutable.Map({ s: Type.union(Type.number, Type.singleton(true)) });
      expectSynth(`!s ? s : 7`, Type.number, env);
    });
  });
});
