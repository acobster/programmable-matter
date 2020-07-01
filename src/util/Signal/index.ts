import * as Immutable from 'immutable';
import Try from '../Try';
import { diffMap } from '../immutable/Map';
import { bug } from '../bug';

const unreconciled = Try.err(new Error('unreconciled'));

/**
 * Simple implementation of reactive values. Values of signals are
 * "reconciled" (brought up to date with respect to child signals)
 * by reevaluating a a tree of signals top-down.
 *
 * A newly-created signal is unreconciled; it must be reconciled in order
 * for its value to be valid.
 *
 * A signal has a value, and a "version". When reconciliation changes a
 * signal's value, the version is incremented. Signals track the
 * versions of their children, in order to determine if they need to be
 * recomputed.
 *
 * A signal is reconciled with respect to a "level", a
 * monotonically-increasing counter. To reconcile a signal, call
 * `reconcile` with a level larger than any level in the DAG rooted at
 * the signal. A signal's level is no larger than the levels of its
 * children.
 *
 * When `reconcile` is called on a signal, if it is already at the given
 * level then nothing need be done, so signals reached by more than one
 * path from the root are reconciled only once. Otherwise, the signal's
 * children are reconciled to the given level, and if any of their versions
 * have changed, the signal is recomputed.
 *
 * Some nodes in the DAG may not be reached by a call to `reconcile`.
 * (E.g. in `b.flatMap(b => b ? s1 : s2)`, if `b` has not changed then
 * `s1` and `s2` are not reached; if it has, only one of them is reached.).
 * If they are reached by a later call to `reconcile`, they'll be reconciled
 * then.
 *
 * In the same way there can be multiple roots, or even multiple disjoint DAGs;
 * only the parts reached by a call to `reconcile` are reconciled.
 */
interface Signal<T> {
  /**
   * equivalent to `.value.get()`
   */
  get(): T;

  map<U>(f: (t: T) => U): Signal<U>;
  flatMap<U>(f: (t: T) => Signal<U>): Signal<U>;
  liftToTry(): Signal<Try<T>>;

  /**
   * value of this signal, up-to-date with respect to `level`.
   */
  value: Try<T>;

  // TODO(jaked) how can we make these private to impl?

  /**
   * if a reconciliation changes `value`, `version` is incremented.
   */
  version: number;

  /**
   * level of the last `reconcile` on this signal.
   */
  level: number;

  /**
   * reconcile this signal to `level`, recomputing `value` as needed.
   * if signal is already at (or above) `level` it need not be recomputed.
   *
   * `reconcile` must be called with monotonically increasing numbers
   * greater than 0.
   */
  reconcile(level: number): void;
}

function equal(v1: any, v2: any): boolean {
  return Immutable.is(v1, v2);
}

abstract class SignalImpl<T> implements Signal<T> {
  abstract get(): T;
  abstract value: Try<T>;
  abstract version: number;
  abstract level: number;
  abstract reconcile(level: number): void;

  map<U>(f: (t: T) => U): Signal<U> { return new Map(this, f); }
  flatMap<U>(f: (t: T) => Signal<U>): Signal<U> { return new FlatMap(this, f); }
  liftToTry(): Signal<Try<T>> { return new LiftToTry(this); }
}

class Const<T> extends SignalImpl<T> {
  constructor(value: Try<T>) {
    super();
    this.value = value;
  }

  get() { return this.value.get(); }
  map<U>(f: (t: T) => U) { return new Map(this, f); }
  flatMap<U>(f: (t: T) => Signal<U>) { return new FlatMap(this, f); }

  value: Try<T>;
  get version(): 1 { return 1; }
  // don't need to track `level` because `reconcile` is a no-op
  get level(): 0 { return 0; }
  reconcile(level: number) { }
}

interface CellIntf<T> extends Signal<T> {
  set(t: Try<T>): void;
  setOk(t: T): void;
  setErr(err: Error): void;
  update(fn: (t: T) => T): void;
}

class CellImpl<T> extends SignalImpl<T> implements CellIntf<T> {
  constructor(value: Try<T>, onChange?: () => void) {
    super();
    this.value = value;
    this.onChange = onChange;
    this.version = 1;
  }

  get() { return this.value.get(); }

  value: Try<T>;
  version: number;
  onChange?: () => void;
  // don't need to track `level` because `reconcile` is a no-op
  get level(): 0 { return 0; }
  reconcile(level: number) { }

  set(t: Try<T>) {
    if (equal(t, this.value)) return;
    this.value = t;
    this.version++;
    if (this.onChange) this.onChange();
  }
  setOk(t: T) { this.set(Try.ok(t)); }
  setErr(err: Error) { this.set(Try.err(err)); }
  update(fn: (t: T) => T) { this.setOk(fn(this.get())); }
}

interface RefIntf<T> extends Signal<T> {
  set(s: Signal<T>): void;
}

class RefImpl<T> extends SignalImpl<T> implements RefIntf<T> {
  s: Signal<T> | undefined = undefined;

  set(s: Signal<T>) {
    if (this.s) throw new Error('Signal.ref already set');
    this.s = s;
  }

  checkedS() {
    if (!this.s) throw new Error('Signal.ref not set');
    else return this.s;
  }

  get() { return this.checkedS().get(); }

  get value() { return this.checkedS().value; }
  get version() { return this.checkedS().version; }
  get level() { return this.checkedS().level; }
  reconcile(level: number) {
    this.checkedS().reconcile(level);
  }
}

class Map<T, U> extends SignalImpl<U> {
  s: Signal<T>;
  sVersion: number;
  f: (t: T) => U;

  constructor(s: Signal<T>, f: (t: T) => U) {
    super();
    this.value = unreconciled;
    this.level = 0;
    this.version = 0;
    this.sVersion = 0;
    this.s = s;
    this.f = f;
  }

  get() { return this.value.get(); }

  value: Try<U>;
  version: number;
  level: number;
  reconcile(level: number) {
    if (this.level === level) return;
    this.level = level;
    this.s.reconcile(level);
    if (this.sVersion === this.s.version) return;
    this.sVersion = this.s.version;
    const value = this.s.value.map(this.f);
    if (equal(value, this.value)) return;
    this.value = value;
    this.version++;
  }
}

class FlatMap<T, U> extends SignalImpl<U> {
  s: Signal<T>;
  sVersion: number;
  fs: Signal<U> | undefined;
  fsVersion: number | undefined;
  f: (t: T) => Signal<U>;

  constructor(s: Signal<T>, f: (t: T) => Signal<U>) {
    super();
    this.value = unreconciled;
    this.level = 0;
    this.version = 0;
    this.sVersion = 0;
    this.s = s;
    this.f = f;
  }

  get() { return this.value.get(); }

  value: Try<U>;
  version: number;
  level: number;
  reconcile(level: number) {
    if (this.level === level) return;
    this.level = level;
    this.s.reconcile(level);
    let value: Try<U>;
    if (this.sVersion === this.s.version) {
      if (!this.fs) return;
      this.fs.reconcile(level);
      if (this.fs.version === this.fsVersion) return;
      this.fsVersion = this.fs.version;
      value = this.fs.value;
    } else {
      this.sVersion = this.s.version;
      if (this.s.value.type === 'ok') {
        try {
          this.fs = this.f(this.s.value.ok);
        } catch (e) {
          this.fs = Signal.err(e);
        }
        this.fs.reconcile(level);
        this.fsVersion = this.fs.version;
        value = this.fs.value;
      } else {
        this.fs = undefined;
        this.fsVersion = undefined;
        value = <Try<U>><unknown>this.s.value;
      }
    }
    if (equal(value, this.value)) return;
    this.value = value;
    this.version++;
  }
}

class LiftToTry<T> extends SignalImpl<Try<T>> {
  s: Signal<T>;

  constructor(s: Signal<T>) {
    super();
    this.s = s;
  }

  get() { return this.s.value; }

  get value(): Try<Try<T>> { return Try.ok(this.s.value); }
  get version(): number { return this.s.version; }
  get level(): number { return this.s.level; }
  reconcile(level: number) {
    this.s.reconcile(level);
  }
}

class Join<T> extends SignalImpl<T[]> {
  signals: Signal<T>[];
  versions: number[];

  constructor(
    signals: Signal<T>[]
  ) {
    super();
    this.value = unreconciled;
    this.level = 0;
    this.version = 0;
    this.signals = signals;
    this.versions = signals.map(s => 0);
  }

  get() { return this.value.get(); }

  value: Try<T[]>;
  version: number;
  level: number;
  reconcile(level: number) {
    if (this.level === level) return;
    this.level = level;
    const versions = this.signals.map(s => {
      s.reconcile(level);
      return s.version;
    });
    // equal() here is very slow :(
    let eqVersions = true;
    for (let i=0; eqVersions && i < versions.length; i++)
      if (versions[i] !== this.versions[i]) eqVersions = false;
    if (eqVersions) return;
    this.versions = versions;
    this.value = Try.join(...this.signals.map(s => s.value));
    this.version++;
  }
}

class JoinImmutableMap<K, V> extends SignalImpl<Immutable.Map<K, V>> {
  s: Signal<Immutable.Map<K, Signal<V>>>;
  sVersion: number;
  vsSignals: Immutable.Map<K, Signal<V>>;
  vsVersions: Immutable.Map<K, number>;

  constructor(
    s: Signal<Immutable.Map<K, Signal<V>>>
  ) {
    super();
    this.value = unreconciled;
    this.level = 0;
    this.version = 0;
    this.sVersion = 0;
    this.s = s;
    this.vsSignals = Immutable.Map();
    this.vsVersions = Immutable.Map();
  }

  get() { return this.value.get(); }

  value: Try<Immutable.Map<K, V>>;
  version: number;
  level: number;
  reconcile(level: number) {
    if (this.level === level) return;
    this.level === level;
    this.s.reconcile(level);
    if (this.sVersion === this.s.version) {
      this.vsSignals.forEach((v, k) => v.reconcile(level));
      if (this.vsSignals.every((v, k) => {
        const vVersion = this.vsVersions.get(k);
        if (vVersion === undefined) bug(`expected vsVersion for ${k}`);
        return v.version === vVersion;
      })) return;

      // TODO(jaked)
      // incrementally update value / versions instead of rebuilding from scratch
      // since it is likely that only some values are updated
      this.vsVersions = this.vsSignals.map(v => v.version);
      this.value = Try.joinImmutableMap(this.vsSignals.map(s => s.value));
      this.version++;
    } else {
      this.sVersion = this.s.version
      if (this.s.value.type === 'ok') {
        this.vsSignals = this.s.value.ok;
        this.vsSignals.forEach(v => v.reconcile(level));

        // TODO(jaked)
        // incrementally update value / versions instead of rebuilding from scratch
        // since it is likely that only some values are updated
        this.vsVersions = this.vsSignals.map(v => v.version);
        this.value = Try.joinImmutableMap(this.vsSignals.map(s => s.value));
      } else {
        this.vsSignals = Immutable.Map();
        this.vsVersions = Immutable.Map();
        this.value = <Try<Immutable.Map<K, V>>><unknown>this.s.value;
      }
      this.version++;
    }
  }
}

class Label<T> extends SignalImpl<T> {
  constructor(label: string, s: Signal<T>) {
    super();
    this.label = label;
    this.s = s;
  }

  get() { return this.s.get(); }

  label: string;
  s: Signal<T>;
  get value() { return this.s.value; }
  get version() { return this.s.version; }
  get level() { return this.s.level; }
  reconcile(level: number) {
    const version = this.s.version;
    if (typeof performance !== 'undefined') {
      performance.mark(this.label);
    }
    try {
      this.s.reconcile(level);
    } catch (e) {
      const err = new Error(this.label);
      err.stack = `${err.stack}\n${e.stack}`;
      throw err;
    }
    if (typeof performance !== 'undefined') {
      const measureLabel =
        this.label + (version !== this.s.version ? ' (changed)' : '');
      try {
        performance.measure(measureLabel, this.label);
      } catch (e) {
        console.log(e);
      }
      performance.clearMarks(this.label);
      performance.clearMeasures(measureLabel);
    }
  }
}

module Signal {
  export function constant<T>(t: Try<T>): Signal<T> {
    return new Const(t);
  }

  export function ok<T>(t: T): Signal<T> {
    return constant(Try.ok(t));
  }

  export function err(err: Error): Signal<never> {
    return constant(Try.err(err));
  }

  export type Cell<T> = CellIntf<T>;

  export function cell<T>(t: Try<T>, onChange?: () => void): Cell<T> {
    return new CellImpl(t, onChange);
  }

  export function cellOk<T>(t: T, onChange?: () => void): Cell<T> {
    return cell(Try.ok(t), onChange);
  }

  export function cellErr<T>(err: Error, onChange: () => void): Cell<T> {
    return cell<T>(Try.err(err), onChange);
  }

  export type Ref<T> = RefIntf<T>;

  export function ref<T>(): Ref<T> {
    return new RefImpl();
  }

  export function mapWithPrev<T, U>(
    s: Signal<T>,
    f: (t: T, prevT: T, prevU: U) => U,
    initT: T,
    initU: U
  ): Signal<U> {
    let currT = initT;
    let currU = initU;
    return s.map(t => {
      currU = f(t, currT, currU);
      currT = t;
      return currU;
    });
  }

  export function join<T1, T2>(
    s1: Signal<T1>,
    s2: Signal<T2>,
  ): Signal<[T1, T2]>
  export function join<T1, T2, T3>(
    s1: Signal<T1>,
    s2: Signal<T2>,
    s3: Signal<T3>,
  ): Signal<[T1, T2, T3]>
  export function join<T1, T2, T3, T4>(
    s1: Signal<T1>,
    s2: Signal<T2>,
    s3: Signal<T3>,
    s4: Signal<T4>,
  ): Signal<[T1, T2, T3, T4]>
  export function join<T1, T2, T3, T4, T5>(
    s1: Signal<T1>,
    s2: Signal<T2>,
    s3: Signal<T3>,
    s4: Signal<T4>,
    s5: Signal<T5>,
  ): Signal<[T1, T2, T3, T4, T5]>
  export function join<T1, T2, T3, T4, T5, T6>(
    s1: Signal<T1>,
    s2: Signal<T2>,
    s3: Signal<T3>,
    s4: Signal<T4>,
    s5: Signal<T5>,
    s6: Signal<T6>,
  ): Signal<[T1, T2, T3, T4, T5, T6]>
  export function join<T1, T2, T3, T4, T5, T6, T7>(
    s1: Signal<T1>,
    s2: Signal<T2>,
    s3: Signal<T3>,
    s4: Signal<T4>,
    s5: Signal<T5>,
    s6: Signal<T6>,
    s7: Signal<T7>,
  ): Signal<[T1, T2, T3, T4, T5, T6, T7]>
  export function join<T1, T2, T3, T4, T5, T6, T7, T8>(
    s1: Signal<T1>,
    s2: Signal<T2>,
    s3: Signal<T3>,
    s4: Signal<T4>,
    s5: Signal<T5>,
    s6: Signal<T6>,
    s7: Signal<T7>,
    s8: Signal<T8>,
  ): Signal<[T1, T2, T3, T4, T5, T6, T7, T8]>
  export function join<T1, T2, T3, T4, T5, T6, T7, T8, T9>(
    s1: Signal<T1>,
    s2: Signal<T2>,
    s3: Signal<T3>,
    s4: Signal<T4>,
    s5: Signal<T5>,
    s6: Signal<T6>,
    s7: Signal<T7>,
    s8: Signal<T8>,
    s9: Signal<T9>,
  ): Signal<[T1, T2, T3, T4, T5, T6, T7, T8, T9]>
  export function join<T>(
    ...signals: Signal<T>[]
  ): Signal<T[]>
  export function join<T>(
    ...signals: Signal<T>[]
  ): Signal<T[]> {
    if (signals.length > 0)
      return new Join(signals);
    else
      return Signal.ok<T[]>([]);
  }

  export function joinObject<T>(
    obj: { [s: string]: Signal<T> }
  ): Signal<{ [s: string]: T }> {
    const keys = Object.keys(obj);
    const signals = Object.values(obj);
    return join(...signals).map(values =>
      keys.reduce<{ [s: string]: T }>(
        (obj, key, i) =>
          Object.assign({}, obj, { [key]: values[i] }),
        { }
      )
    );
  }

  export function joinImmutableMap<K, V>(
    map: Signal<Immutable.Map<K, Signal<V>>>
  ): Signal<Immutable.Map<K, V>> {
    return new JoinImmutableMap(map);
  }

  export function mapImmutableMap<K, V, U>(
    input: Signal<Immutable.Map<K, V>>,
    f: (v: V, k: K, coll: Immutable.Map<K, V>) => U
  ): Signal<Immutable.Map<K, U>> {
    let prevInput: Immutable.Map<K, V> = Immutable.Map();
    let prevOutput: Immutable.Map<K, U> = Immutable.Map();
    return input.map(input => {
      const output = prevOutput.withMutations(output => {
        const { added, changed, deleted } = diffMap(prevInput, input);
        deleted.forEach(key => { output = output.delete(key) });
        changed.forEach(([prev, curr], key) => { output = output.set(key, f(curr, key, input)) });
        added.forEach((v, key) => { output = output.set(key, f(v, key, input)) });
      });
      prevInput = input;
      prevOutput = output;
      return output;
    })
  }

  export function label<T>(label: string, s: Signal<T>): Signal<T> {
    return new Label(label, s);
  }
}

export default Signal;
