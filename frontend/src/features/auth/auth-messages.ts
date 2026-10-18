export type AuthMode = "sign-in" | "sign-up";

export function authErrorMessage(mode: AuthMode, status: number): string {
  if (status === 401) return "Email or password is wrong";
  if (status === 409) return "An account with that email already exists";
  if (status === 422) {
    return mode === "sign-up"
      ? "Use a valid email and a password of at least 8 characters"
      : "Enter a valid email and your password";
  }
  if (status === 403) return "This request was blocked. Reload the page and try again";
  return "Something went wrong. Try again in a moment";
}
