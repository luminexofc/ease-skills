import { useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AlertCircle, Check, Loader2, Plus } from "lucide-react";
import { submitSkill } from "@/lib/submissions.functions";
import type { SubmissionResult } from "@/lib/types";

/**
 * Submit form. The result is reported honestly: a verified repo says it is
 * listed, an unverifiable one says it is queued and why, and a non-repo says so.
 * The form never claims success it did not get.
 */
export function SubmitForm({ onAdded }: { onAdded?: () => void }) {
  const submit = useServerFn(submitSkill);
  const [url, setUrl] = useState("");
  const [submitter, setSubmitter] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await submit({ data: { url: url.trim(), submitter: submitter.trim(), note: "" } });
      setResult(res);
      if (res.ok) {
        setUrl("");
        onAdded?.();
      }
    } catch {
      setError("The submission did not go through. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center gap-2 rounded-sm border border-line-strong bg-card px-3 text-sm font-medium text-ink transition-colors hover:border-ink/40"
      >
        <Plus className="size-4" aria-hidden="true" />
        Add a skill or server
      </button>
    );
  }

  const tone =
    result?.state === "approved"
      ? "border-teal bg-teal-soft text-teal"
      : result?.state === "duplicate"
        ? "border-line-strong bg-paper text-muted"
        : "border-clay-ink bg-clay-soft text-clay-ink";

  return (
    <section
      aria-label="Submit a skill or server"
      className="rounded-sm border border-line-strong bg-card p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-ink">Put yours in the index</h2>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">
            Paste a public link. GitHub, GitLab, and Bitbucket are checked for a free licence and
            for being a skill or an MCP server before they appear; anywhere else you publish
            (npm, PyPI, your own site, a registry) goes to the review queue.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-sm border border-line-strong text-ink hover:bg-paper"
          aria-label="Close the submit form"
        >
          <span aria-hidden="true" className="text-lg leading-none">
            ×
          </span>
        </button>
      </div>

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="label-caps text-muted">Repository</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            placeholder="https://github.com/owner/repo"
            className="h-12 rounded-sm border border-line-strong bg-paper px-3 text-base text-ink placeholder:text-muted focus-visible:border-teal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
          />
          <span className="text-xs text-muted">
            GitHub, GitLab, or Bitbucket. <code className="text-ink">owner/repo</code> works too.
            Any other public URL is queued for review.
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="label-caps text-muted">Credit (optional)</span>
          <input
            value={submitter}
            onChange={(e) => setSubmitter(e.target.value)}
            maxLength={80}
            placeholder="Your name or handle"
            className="h-11 rounded-sm border border-line-strong bg-paper px-3 text-sm text-ink placeholder:text-muted focus-visible:border-teal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
          />
        </label>

        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="inline-flex min-h-11 items-center gap-2 rounded-sm bg-teal px-4 text-sm font-semibold text-card transition-colors hover:bg-[#0b5c54] disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="size-4" aria-hidden="true" />
            )}
            {busy ? "Checking the repository" : "Check and add"}
          </button>
          <span className="text-xs text-muted">No account, no email.</span>
        </div>
      </form>

      <div aria-live="polite">
        {result && (
          <p className={`mt-3 flex items-start gap-2 rounded-sm border px-3 py-2 text-sm ${tone}`}>
            {result.state === "approved" ? (
              <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            ) : (
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            )}
            <span>{result.message}</span>
          </p>
        )}
        {error && (
          <p className="mt-3 flex items-start gap-2 rounded-sm border border-clay-ink bg-clay-soft px-3 py-2 text-sm text-clay-ink">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </section>
  );
}
