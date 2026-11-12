/** Who is loading this configuration. */
export type Role = "controller" | "relay" | "proxy" | "all";

export function parseRole(env: NodeJS.ProcessEnv): Role {
  const role = (env.ROLE ?? "controller") as Role;
  if (!["controller", "relay", "proxy", "all"].includes(role)) {
    throw new Error(`invalid ROLE ${role}`);
  }
  return role;
}
