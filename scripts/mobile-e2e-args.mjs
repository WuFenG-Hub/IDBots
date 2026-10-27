export function getMobileE2eArgs(argv = process.argv) {
  const args = argv.slice(2);
  return args[0] === '--' ? args.slice(1) : args;
}
