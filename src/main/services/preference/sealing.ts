import { randomBytes } from 'node:crypto';
import { canonJ, sha256Hex } from '../metatask/canon';

export const newBallotSalt = (): string => randomBytes(32).toString('hex');

export const ballotCommitHash = (input: { round: string; judge: string; salt: string; ballot: unknown }): string =>
  sha256Hex(canonJ({ round: input.round, judge: input.judge, salt: input.salt, ballot: input.ballot }));
