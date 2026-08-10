export type InstanceAuthMode = "required" | "disabled" | "unconfigured";

export const isUnauthenticatedAccessEnabled = (value: string | undefined) =>
  value?.trim().toLowerCase() === "true";

export const resolveInstanceAuthMode = ({
  allowUnauthenticated,
  hasBootstrapCredential,
  hasEnabledUser,
}: {
  allowUnauthenticated: boolean;
  hasBootstrapCredential: boolean;
  hasEnabledUser: boolean;
}): InstanceAuthMode => {
  if (allowUnauthenticated) {
    return "disabled";
  }

  if (hasBootstrapCredential || hasEnabledUser) {
    return "required";
  }

  return "unconfigured";
};

export const isDatabaseNotReadyError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Only match errors that genuinely indicate the D1 binding is missing or
  // migrations have not been applied. Avoid matching every D1_ERROR prefix
  // (e.g. UNIQUE constraint failures, CHECK violations) which would falsely
  // report a ready database as "database_not_ready".
  return /no such table|no such column|DB\.prepare is not a function|Cannot read properties of undefined.*prepare|D1_ERROR:.*no such/i.test(
    message,
  );
};
