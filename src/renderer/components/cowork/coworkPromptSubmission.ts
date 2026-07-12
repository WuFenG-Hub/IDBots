export interface VersionedComposerSnapshot<T> {
  value: T;
  clearedRevision: number;
}

export interface VersionedComposerField<T> {
  get: () => T;
  set: (value: T) => number;
  takeAndClear: () => VersionedComposerSnapshot<T>;
  restoreIfUnchanged: (snapshot: VersionedComposerSnapshot<T>) => boolean;
}

export const createVersionedComposerField = <T>(
  initialValue: T,
  createEmptyValue: () => T,
  publish: (value: T) => void,
): VersionedComposerField<T> => {
  let value = initialValue;
  let revision = 0;

  const set = (nextValue: T): number => {
    value = nextValue;
    revision += 1;
    publish(nextValue);
    return revision;
  };

  return {
    get: () => value,
    set,
    takeAndClear: () => {
      const submittedValue = value;
      const clearedRevision = set(createEmptyValue());
      return { value: submittedValue, clearedRevision };
    },
    restoreIfUnchanged: (snapshot) => {
      if (revision !== snapshot.clearedRevision) return false;
      set(snapshot.value);
      return true;
    },
  };
};

export const settleComposerSubmission = async <T>(
  field: VersionedComposerField<T>,
  snapshot: VersionedComposerSnapshot<T>,
  submission: void | boolean | Promise<void | boolean>,
): Promise<void | boolean> => {
  try {
    const accepted = await submission;
    if (accepted === false) {
      field.restoreIfUnchanged(snapshot);
    }
    return accepted;
  } catch (error) {
    field.restoreIfUnchanged(snapshot);
    throw error;
  }
};

export const runComposerSubmission = async <T>(
  field: VersionedComposerField<T>,
  snapshot: VersionedComposerSnapshot<T>,
  submit: () => void | boolean | Promise<void | boolean>,
): Promise<void | boolean> => {
  let submission: void | boolean | Promise<void | boolean>;
  try {
    submission = submit();
  } catch (error) {
    field.restoreIfUnchanged(snapshot);
    throw error;
  }
  return settleComposerSubmission(field, snapshot, submission);
};
