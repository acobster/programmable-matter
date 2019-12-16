import * as Immutable from 'immutable';

// TODO(jaked) this must exist already
// TODO(jaked) is there a way to get Scala-ish Try(() => ...) ?

class Ok<T> {
  type = 'ok' as const;

  ok: T;
  constructor(ok: T) { this.ok = ok; }

  get() { return this.ok; }
  map<U>(f: (t: T) => U) { return Try.apply(() => f(this.ok)); }
  flatMap<U>(f: (t: T) => Try<U>) {
    const tt = Try.apply(() => f(this.ok));
    if (tt.type === 'ok') return tt.ok;
    else return <Try<U>><unknown>tt;
  }
  forEach(f: (t: T) => void) { return f(this.ok); }

  equals(other: any): boolean {
    return (
      this === other ||
      other && other.ok && Immutable.is(this.ok, other.ok)
    )
  }

  hashCode(): number {
    return Immutable.hash(this.ok);
  }
}

class Err {
  type = 'err' as const;

  err: Error;
  constructor(err: Error) { this.err = err; }

  get(): never { throw this.err; }
  map<U>(f: (t: never) => U): Try<never> { return this; }
  flatMap<U>(f: (t: never) => Try<U>): Try<never> { return this; }
  forEach(f: (t: never) => void) { }

  equals(other: any): boolean {
    return (
      this === other ||
      other && other.ok && Immutable.is(this.err, other.err)
    )
  }

  hashCode(): number {
    return Immutable.hash(this.err);
  }
}

type Try<T> = {
  get: () => T;
  map<U>(f: (t: T) => U): Try<U>;
  flatMap<U>(f: (t: T) => Try<U>): Try<U>;
  forEach(f: (t: T) => void): void;
} & ({ type: 'ok'; ok: T; } | { type: 'err'; err: Error; })

module Try {
  export function ok<T>(ok: T): Try<T> { return new Ok(ok); }
  export function err(err: Error): Try<never> { return new Err(err); }

  export function apply<T>(f: () => T) {
    try { return ok(f()); }
    catch (e) { return err(e); }
  }

  export function joinMap<T1, T2, R>(
    try1: Try<T1>,
    try2: Try<T2>,
    f: (t1: T1, t2: T2) => R
  ): Try<R>
  export function joinMap<T, R>(
    ...args: any[]
  ): Try<R>
  export function joinMap<T, R>(...args: any[]): Try<R> {
    const trys = args.slice(0, args.length - 1);
    const f = args[args.length - 1];
    for (let i = 0; i < trys.length; i++) {
      if (trys[i].type === 'err') return <Try<R>><unknown>trys[i];
    }
    return apply(() => f(...trys.map(t => t.ok)));
  }
}

export default Try;