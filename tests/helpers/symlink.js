import { symlink } from 'node:fs/promises';

// Skip only the test whose premise requires this capability; do not suppress product failures.
export async function testSymlink(t,target,path,type='file') {
  try { await symlink(target,path,type);return true; }
  catch(error) {
    if(!['EPERM','EACCES','ENOTSUP','ENOSYS'].includes(error.code))throw error;
    t.skip(`Symbolic-link creation is unavailable on this host (${error.code}); requires filesystem support/permission.`);
    return false;
  }
}
