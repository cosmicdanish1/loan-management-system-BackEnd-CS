import { ILike, Repository } from 'typeorm';
import { UserMaster } from '../entities/user-master.entity';

/**
 * Finds a person by login name ignoring letter case (ES-659). New names are already unique ignoring case (ES-266) and the
 * legacy database matches any case ("test1212", "TEST1212" and "Test1212" are one login), but sign-in and Change Password
 * compared the text exactly. The exact spelling is tried first (one cheap indexed lookup); only a miss does the
 * case-insensitive search, with LIKE characters in the name escaped so "%" or "_" mean themselves.
 */
export async function findUserMasterByName(
  repo: Repository<UserMaster>,
  username: string,
  relations?: string[],
): Promise<UserMaster | null> {
  const name = String(username ?? '').trim();
  if (!name) return null;
  const exact = await repo.findOne({ where: { susername: name }, ...(relations ? { relations } : {}) });
  if (exact) return exact;
  return repo.findOne({
    where: { susername: ILike(name.replace(/[\\%_]/g, (c) => `\\${c}`)) },
    ...(relations ? { relations } : {}),
  });
}
