"use client";

/* eslint-disable @next/next/no-img-element */
import { Upload, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JobOutput, JobStatus } from "@/lib/comfy/types";
import type { BlueprintInput, BlueprintListEntry } from "@/lib/blueprints/types";
import { TruncatedText } from "@/components/ui/truncated-text";

type BlueprintSpec = BlueprintListEntry & { online: boolean };

interface MediaValue {
  ref: string;
  filename: string;
  previewUrl?: string;
}

const MEDIA_ACCEPT: Record<string, string> = { image: "image/*", mask: "image/*", video: "video/*", audio: "audio/*" };

function isMediaKind(kind: BlueprintInput["kind"]): boolean {
  return kind in MEDIA_ACCEPT;
}

/**
 * A generic form for one blueprint from the registry: fetches its input spec, renders prompts,
 * media slots and numeric fields, and queues a run that the /api/jobs flow tracks. When the
 * blueprint's models or nodes are missing it says exactly what is needed instead.
 */
export function BlueprintRunner({ id, onQueued, className = "" }: { id: string; onQueued?: (jobId: string) => void; className?: string }) {
  const t = useTranslations("blueprintRunner");
  const [spec, setSpec] = useState<BlueprintSpec | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string | number>>({});
  const [media, setMedia] = useState<Record<string, MediaValue>>({});
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset per-blueprint state when the id prop changes, during render rather than in an effect.
  const [loadedFor, setLoadedFor] = useState(id);
  if (loadedFor !== id) {
    setLoadedFor(id);
    setSpec(null);
    setLoadError(null);
    setValues({});
    setMedia({});
    setJob(null);
    setRunError(null);
  }

  useEffect(() => {
    let cancelled = false;
    if (pollRef.current) clearInterval(pollRef.current);
    fetch(`/api/blueprints/${encodeURIComponent(id)}`)
      .then(async (res) => {
        const body = (await res.json()) as BlueprintSpec & { error?: string };
        if (!res.ok) throw new Error(body.error ?? t("loadFailed"));
        if (!cancelled) setSpec(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : t("loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  const startPolling = useCallback((jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      void fetch(`/api/jobs/${encodeURIComponent(jobId)}`)
        .then((res) => res.json())
        .then((s: JobStatus) => {
          setJob(s);
          if ((s.state === "done" || s.state === "error") && pollRef.current) clearInterval(pollRef.current);
        })
        .catch(() => undefined);
    }, 2500);
  }, []);

  const upload = async (input: BlueprintInput, file: File) => {
    setUploadingKey(input.key);
    setRunError(null);
    try {
      const form = new FormData();
      form.append("files", file, file.name);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const body = (await res.json()) as { files?: (JobOutput & { ref: string })[]; error?: string };
      if (!res.ok || !body.files?.length) throw new Error(body.error ?? t("uploadFailed"));
      const uploaded = body.files[0];
      const previewUrl = input.kind === "image" || input.kind === "mask" ? URL.createObjectURL(file) : undefined;
      setMedia((m) => ({ ...m, [input.key]: { ref: uploaded.ref, filename: file.name, previewUrl } }));
    } catch (err) {
      setRunError(err instanceof Error ? err.message : t("uploadFailed"));
    } finally {
      setUploadingKey(null);
    }
  };

  const run = async () => {
    if (!spec) return;
    setSubmitting(true);
    setRunError(null);
    setJob(null);
    try {
      const payload: Record<string, string | number> = { ...values };
      for (const [key, m] of Object.entries(media)) payload[key] = m.ref;
      const res = await fetch(`/api/blueprints/${encodeURIComponent(spec.id)}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: payload }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? t("queueFailed"));
      setJob({ id: body.id, state: "queued", outputs: [] });
      onQueued?.(body.id);
      startPolling(body.id);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : t("queueFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  if (loadError) return <p className={`break-words font-mono text-[11px] leading-relaxed text-danger ${className}`}>{loadError}</p>;
  if (!spec) return <span role="status" aria-label={t("loadingAria")} className={`pulse block h-[180px] w-full rounded-[16px] bg-pill ${className}`} />;

  const missing = spec.status === "missing";
  const requiredReady = spec.inputs.filter((i) => isMediaKind(i.kind) && i.required).every((i) => media[i.key]);
  const canRun = spec.status === "ready" && requiredReady && !submitting && uploadingKey === null;
  const prompts = spec.inputs.filter((i) => i.kind === "prompt" || i.kind === "negative-prompt");
  const mediaInputs = spec.inputs.filter((i) => isMediaKind(i.kind));
  const numbers = spec.inputs.filter((i) => i.kind === "number");

  return (
    <section className={`flex min-h-0 flex-col gap-4 ${className}`}>
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <TruncatedText as="h2" text={spec.name} className="font-display text-[17px] font-bold tracking-[-0.01em] text-ink" />
        <span className="shrink-0 rounded-full bg-pill px-2 py-0.5 font-mono text-[10.5px] text-ink-muted">{spec.category}</span>
      </div>

      {missing ? (
        <div className="flex flex-col gap-2 rounded-[12px] border border-danger/30 bg-danger-wash px-3 py-2.5 text-[13px] leading-relaxed text-ink">
          <p className="font-medium">{t("missingIntro")}</p>
          {spec.missingModels.length > 0 ? (
            <div>
              <p className="text-[12px] font-medium text-faint">{t("missingModels")}</p>
              <ul className="mt-0.5 list-inside list-disc font-mono text-[11px] leading-relaxed">
                {spec.missingModels.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {spec.missingNodeClasses.length > 0 ? (
            <div>
              <p className="text-[12px] font-medium text-faint">{t("missingNodes")}</p>
              <ul className="mt-0.5 list-inside list-disc font-mono text-[11px] leading-relaxed">
                {spec.missingNodeClasses.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-[12px] text-faint">{t("missingHint")}</p>
        </div>
      ) : null}
      {spec.status === "unknown" ? (
        <p className="rounded-[12px] border border-line bg-paper px-3 py-2 text-[13px] leading-relaxed text-ink-muted">{t("offline")}</p>
      ) : null}

      {mediaInputs.map((input) => (
        <div key={input.key} className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-faint">
            {input.label}
            {!input.required ? <span className="ms-1.5 font-mono text-[10.5px] text-placeholder">{t("optional")}</span> : null}
          </span>
          {media[input.key] ? (
            // flex-wrap: at narrow widths (§5.14) the filename and remove button
            // wrap under the preview instead of clipping past the edge.
            <div className="flex flex-wrap items-center gap-2.5 rounded-[12px] border border-line bg-paper p-2">
              {media[input.key].previewUrl ? (
                <img src={media[input.key].previewUrl} alt={input.label} className="h-[52px] w-[52px] rounded-[8px] border border-line object-cover" />
              ) : (
                <span className="flex h-[52px] w-[52px] items-center justify-center rounded-[8px] bg-pill font-mono text-[10px] uppercase text-ink-muted">{input.kind}</span>
              )}
              <TruncatedText text={media[input.key].filename} className="flex-1 basis-24 font-mono text-[11px] text-ink" />
              <button
                type="button"
                aria-label={t("removeMedia", { label: input.label })}
                onClick={() =>
                  setMedia((m) => {
                    const next = { ...m };
                    delete next[input.key];
                    return next;
                  })
                }
                className="rounded-full p-1 text-ink-muted hover:bg-pill hover:text-ink"
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <label className="flex cursor-pointer items-center gap-2 rounded-[12px] border border-dashed border-line px-3 py-2.5 text-[13px] text-ink-muted transition-colors hover:border-faint hover:text-ink">
              <Upload size={14} />
              {uploadingKey === input.key ? t("uploading") : t("addMedia", { kind: input.kind })}
              <input
                type="file"
                accept={MEDIA_ACCEPT[input.kind]}
                className="hidden"
                disabled={uploadingKey !== null}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(input, file);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </div>
      ))}

      {prompts.map((input) => (
        <div key={input.key} className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-faint">{input.label}</span>
          <textarea
            aria-label={input.label}
            value={String(values[input.key] ?? input.default ?? "")}
            onChange={(e) => setValues((v) => ({ ...v, [input.key]: e.target.value }))}
            rows={input.kind === "prompt" ? 3 : 2}
            placeholder={input.kind === "negative-prompt" ? t("negativePlaceholder") : t("promptPlaceholder")}
            className="field min-h-[64px] w-full resize-y text-[14px] leading-[1.5]"
          />
        </div>
      ))}

      {numbers.length > 0 ? (
        // Number fields stack in one column below 640 (§5.14).
        <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
          {numbers.map((input) => (
            <label key={input.key} className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-faint">{input.label}</span>
              <input
                type="number"
                value={values[input.key] ?? (input.seed ? "" : (input.default ?? ""))}
                placeholder={input.seed ? t("randomPlaceholder") : input.default !== undefined ? String(input.default) : ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  setValues((v) => {
                    const next = { ...v };
                    if (raw === "") delete next[input.key];
                    else next[input.key] = Number(raw);
                    return next;
                  });
                }}
                className="field h-9 font-mono text-xs"
              />
            </label>
          ))}
        </div>
      ) : null}

      {runError ? <p className="break-words font-mono text-[11px] leading-relaxed text-danger">{runError}</p> : null}

      <button type="button" disabled={!canRun} onClick={() => void run()} className="btn-primary h-[46px] rounded-[14px] text-[14px]">
        {submitting ? t("queueing") : missing ? t("missingRequirements") : t("run")}
      </button>

      {job ? (
        <div className="flex flex-col gap-2 rounded-[12px] bg-paper p-3">
          <div className="flex items-center justify-between font-mono text-[11px] text-faint">
            <span>{t("jobLabel", { id: job.id.slice(0, 8) })}</span>
            <span role="status" className={job.state === "error" ? "text-danger" : job.state === "done" ? "text-green" : ""}>
              {job.state}
            </span>
          </div>
          {job.error ? <p className="break-words font-mono text-[11px] leading-relaxed text-danger">{job.error}</p> : null}
          {job.outputs.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {job.outputs.map((out) => {
                const src = `/api/view?filename=${encodeURIComponent(out.filename)}&subfolder=${encodeURIComponent(out.subfolder ?? "")}&type=${encodeURIComponent(out.type ?? "output")}`;
                return /\.(png|jpe?g|webp)$/i.test(out.filename) ? (
                  <img key={out.filename} src={src} alt={out.filename} className="h-[88px] w-[88px] rounded-[10px] border border-line object-cover" />
                ) : (
                  <a key={out.filename} href={src} target="_blank" rel="noreferrer" className="max-w-full rounded-[8px] bg-pill px-2 py-1 font-mono text-[11px] text-ink [overflow-wrap:anywhere] hover:bg-line">
                    {out.filename}
                  </a>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
