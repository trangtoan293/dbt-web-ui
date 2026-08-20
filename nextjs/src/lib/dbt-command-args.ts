const COMMANDS_WITH_EXTRA_ARGS = new Set(["build", "compile", "run", "show"]);
const COMMANDS_WITH_FULL_REFRESH = new Set(["build", "compile", "run", "show"]);

export const getDbtCommandName = (command: string): string =>
  command.trim().split(/\s+/, 1)[0] || "";

export const buildDbtAdditionalArgs = (
  commandName: string,
  extraArgs: string,
  fullRefresh: boolean,
): string => {
  let args = extraArgs.trim();

  if (
    fullRefresh &&
    COMMANDS_WITH_FULL_REFRESH.has(commandName) &&
    !/(^|\s)(--full-refresh|-f)(\s|$)/.test(args)
  ) {
    args = args ? `${args} --full-refresh` : "--full-refresh";
  }

  return args;
};

export const buildDbtCommandWithArgs = (
  command: string,
  extraArgs: string,
  fullRefresh: boolean,
): string => {
  const commandName = getDbtCommandName(command);
  const args = buildDbtAdditionalArgs(commandName, extraArgs, fullRefresh);

  const commandWithArgs =
    args && COMMANDS_WITH_EXTRA_ARGS.has(commandName) ? `${command} ${args}` : command;

  return commandWithArgs;
};
