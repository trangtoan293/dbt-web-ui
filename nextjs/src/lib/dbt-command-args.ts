const COMMANDS_WITH_EXTRA_ARGS = new Set(["build", "compile", "run", "show"]);
const COMMANDS_WITH_FULL_REFRESH = new Set(["build", "compile", "run", "show"]);

/**
 * A target name becomes a `--target` argument and a profiles.yml output key.
 * Same shape the runner enforces, checked here too so a malformed name is
 * dropped rather than sent as an argument dbt will reject.
 */
const TARGET_NAME_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;

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
  target?: string | null,
): string => {
  const commandName = getDbtCommandName(command);
  const args = buildDbtAdditionalArgs(commandName, extraArgs, fullRefresh);

  const commandWithArgs =
    args && COMMANDS_WITH_EXTRA_ARGS.has(commandName) ? `${command} ${args}` : command;

  // One place appends the target, so every menu entry, keyboard shortcut and
  // terminal command runs against the selected environment - a per-caller
  // append would leave whichever path was forgotten silently on `dev`.
  const wanted = target?.trim();
  if (
    wanted &&
    TARGET_NAME_PATTERN.test(wanted) &&
    !/(^|\s)(--target|-t)(\s|=|$)/.test(commandWithArgs)
  ) {
    return `${commandWithArgs} --target ${wanted}`;
  }

  return commandWithArgs;
};
