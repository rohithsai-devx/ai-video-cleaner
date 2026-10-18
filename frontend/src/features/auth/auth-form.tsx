"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { fetchClient } from "@/api/client";
import { Button } from "@/ui/button";
import { Field } from "@/ui/field";
import { authErrorMessage, type AuthMode } from "./auth-messages";
import { safeNext } from "./safe-next";

const COPY: Record<AuthMode, { title: string; submit: string; busy: string }> = {
  "sign-in": { title: "Sign in", submit: "Sign in", busy: "Signing in…" },
  "sign-up": { title: "Create your account", submit: "Create account", busy: "Creating account…" },
};

export function AuthForm({ mode, next }: { mode: AuthMode; next?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const copy = COPY[mode];
  const destination = safeNext(next);
  const nextQuery = next ? `?next=${encodeURIComponent(destination)}` : "";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setPending(true);
    setError(null);
    try {
      const { response } =
        mode === "sign-in"
          ? await fetchClient.POST("/auth/signin", { body: { email, password } })
          : await fetchClient.POST("/auth/signup", {
              body: { email, password, name: String(form.get("name") ?? "").trim() || null },
            });
      if (!response.ok) {
        setError(authErrorMessage(mode, response.status));
        setPending(false);
        return;
      }
      router.replace(destination);
      router.refresh();
    } catch {
      setError(authErrorMessage(mode, 0));
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate={false}
      className="flex w-full max-w-[380px] flex-col gap-5"
    >
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-5xl font-medium tracking-tight text-ink">{copy.title}</h1>
        <p className="text-[15px] leading-relaxed text-muted">
          Record your screen, let the agent tidy it, share a clean video.
        </p>
      </div>
      {mode === "sign-up" ? (
        <Field label="Name" name="name" autoComplete="name" maxLength={200} />
      ) : null}
      <Field label="Work email" name="email" type="email" autoComplete="email" required />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
        minLength={mode === "sign-up" ? 8 : 1}
        maxLength={256}
        required
      />
      {error ? (
        <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="text-[15px]">
        {pending ? copy.busy : copy.submit}
      </Button>
      {mode === "sign-in" ? (
        <p className="text-sm text-muted">
          New here?{" "}
          <Link href={`/sign-up${nextQuery}`} className="font-medium text-ink hover:text-ink-2">
            Create an account
          </Link>
        </p>
      ) : (
        <p className="text-sm text-muted">
          Already have an account?{" "}
          <Link href={`/sign-in${nextQuery}`} className="font-medium text-ink hover:text-ink-2">
            Sign in
          </Link>
        </p>
      )}
    </form>
  );
}
