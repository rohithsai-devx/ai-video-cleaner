/** Ends the session. Served by the Next route app/api/auth/signout (not FastAPI), so it is not in the generated paths. */
export async function signOut(): Promise<void> {
  await fetch("/api/auth/signout", { method: "POST" });
}
