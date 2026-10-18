import { AuthForm } from "./auth-form";
import type { AuthMode } from "./auth-messages";

const RAW = [7, 18, 9, 22, 14, 16, 14];
const KEPT = [18, 22, 16];

function Logo() {
  return (
    <div className="flex items-center gap-2.5 text-[17px] font-semibold text-ink">
      <span className="inline-flex size-7 items-center justify-center rounded-xl bg-ink">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="2.4"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 4v16M12 8v8M18 6v12" />
        </svg>
      </span>
      Stepwise
    </div>
  );
}

function Showcase() {
  return (
    <div className="flex flex-1 flex-col justify-center gap-9 rounded-3xl bg-ink p-10 text-[#F4F4F2] md:p-14">
      <p className="max-w-[26ch] text-[28px] leading-snug font-medium tracking-tight">
        A 6-minute take becomes a 2-minute walkthrough, with every cut explained.
      </p>
      <div className="flex flex-col gap-3.5" aria-hidden="true">
        <div className="font-mono text-xs text-[#A3A3A3]">Raw recording 6:12</div>
        <div className="flex h-7 gap-[3px]">
          {RAW.map((flex, i) => (
            <span
              key={i}
              style={{ flex }}
              className={i % 2 ? "rounded bg-[#F4F4F2]" : "rounded bg-white/15"}
            />
          ))}
        </div>
        <div className="font-mono text-xs text-[#A3A3A3]">Cleaned 2:04</div>
        <div className="flex h-7 w-[56%] gap-[3px]">
          {KEPT.map((flex, i) => (
            <span key={i} style={{ flex }} className="rounded bg-accent" />
          ))}
        </div>
      </div>
      <ul className="flex flex-col gap-2.5 text-[15px] text-[#D4D4D8]">
        <li>Dead air, retakes and slow scrolls removed</li>
        <li>Script rewritten from what you said</li>
        <li>Optional AI voiceover in your workspace voice</li>
      </ul>
    </div>
  );
}

export function AuthScreen({ mode, next }: { mode: AuthMode; next?: string }) {
  return (
    <main className="flex min-h-dvh flex-wrap bg-canvas text-ink">
      <div className="flex min-w-0 flex-[1_1_480px] flex-col justify-between gap-12 px-6 py-10 sm:px-14">
        <Logo />
        <AuthForm mode={mode} next={next} />
        <p className="text-[13px] text-muted">
          Recordings stay in your workspace until you share them.
        </p>
      </div>
      <div className="hidden min-w-0 flex-[1_1_520px] p-6 md:flex">
        <Showcase />
      </div>
    </main>
  );
}
