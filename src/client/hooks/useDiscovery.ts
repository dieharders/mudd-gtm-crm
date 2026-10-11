/**
 * One Discovery campaign's state on the page: the thesis (autosaved as the user types), the
 * runs, and the inbox of candidates. Does nothing for a campaign without a thesis.
 *
 * Accepting a candidate is a server-side step (it adds the prospect, its contacts and the intel
 * columns, and queues enrichment); the rows it adds come back in the reply and over the stream,
 * and are shown either way, once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { isLiveStatus, newestFirst, withRun, type CampaignEvent } from "../../shared/ai";
import { inboxOrder, type Candidate, type DiscoveryRun } from "../../shared/sourcing";
import type { Thesis, ThesisId } from "../../shared/types";
import { api, type StartDiscoveryBody } from "../lib/api";
import { useCampaignEvents } from "../lib/campaignEvents";
import { useLoadOnce } from "../lib/loadOnce";
import type { CampaignState } from "./useCampaign";
import type { ConsentGate } from "./useConsentGate";

const THESIS_DEBOUNCE = 600;

/**
 * Candidates the server sent, merged in: each replaces the page's copy unless that copy is
 * newer. The server stamps every change, so a request's reply that was overtaken by the stream
 * (the initial load, with a run mapping companies meanwhile) cannot roll a candidate back.
 */
function withCandidates(prev: Candidate[], changed: Candidate[]): Candidate[] {
  const byId = new Map(changed.map((c) => [c.id, c]));
  const kept = prev.map((c) => {
    const next = byId.get(c.id);
    return next && next.updatedAt >= c.updatedAt ? next : c;
  });
  const known = new Set(prev.map((c) => c.id));
  return [...kept, ...changed.filter((c) => !known.has(c.id))];
}

export function useDiscovery(state: CampaignState, consent: ConsentGate) {
  const { thesis, setThesis } = state;
  const id = thesis ? state.campaign?.id ?? "" : "";
  const [runs, setRuns] = useState<DiscoveryRun[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);

  useLoadOnce(id, (current) => {
    api.discovery(id).then((d) => {
      if (!current()) return;
      setRuns((prev) => d.runs.reduce(withRun, prev.filter((r) => r.campaignId === id)));
      setCandidates((prev) => withCandidates(prev.filter((c) => c.campaignId === id), d.candidates));
    }).catch(() => {});
  });

  // ----- the thesis: typed answers go to the server a moment after the typing stops -----
  // What is typed and not yet sent, and what is sent and not yet acknowledged: both are the
  // user's, and win over a thesis the server publishes meanwhile (a draft turn that ran before
  // the PUT landed would otherwise put its draft back over the typed answer).
  const pending = useRef<Map<ThesisId, string | null>>(new Map());
  const inflight = useRef<Map<ThesisId, string | null>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushThesis = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!pending.current.size || !id) return;
    const answers = Object.fromEntries(pending.current) as Partial<Record<ThesisId, string | null>>;
    for (const [qid, v] of pending.current) inflight.current.set(qid, v);
    pending.current.clear();
    try {
      await api.updateThesis(id, { answers });
    } catch (err) {
      toast.error(`Thesis not saved: ${(err as Error).message}`, { id: "thesis-error" });
    } finally {
      // Only what this PUT carried: a later flush may have the same question in flight anew.
      for (const [qid, v] of Object.entries(answers) as [ThesisId, string | null][]) if (inflight.current.get(qid) === v) inflight.current.delete(qid);
    }
  }, [id]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    // Nothing typed is lost to leaving the page: send what is waiting on the way out.
    if (pending.current.size && id) void api.updateThesis(id, { answers: Object.fromEntries(pending.current) }).catch(() => {});
  }, [id]);

  /** Change one answer. An AI draft the user edits is theirs. */
  const setAnswer = useCallback((qid: ThesisId, value: string) => {
    setThesis((t: Thesis | null) => {
      if (!t) return t;
      const answers = { ...t.answers };
      if (value.trim()) answers[qid] = value;
      else delete answers[qid];
      return { ...t, answers, drafted: t.drafted.filter((d) => d !== qid) };
    });
    pending.current.set(qid, value.trim() ? value : null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flushThesis(), THESIS_DEBOUNCE);
  }, [flushThesis, setThesis]);

  /** Keep an AI draft as it is: it is the user's now. */
  const keepDraft = useCallback((qid: ThesisId) => {
    setThesis((t: Thesis | null) => (t ? { ...t, drafted: t.drafted.filter((d) => d !== qid) } : t));
    void flushThesis().then(() => api.updateThesis(id, { keep: [qid] })).catch((e: Error) => toast.error(e.message));
  }, [flushThesis, id, setThesis]);

  // ----- live updates -----
  const { applyRemoteRows, replaceCampaign } = state;
  useCampaignEvents(id, useCallback((ev: CampaignEvent) => {
    if (ev.type === "discovery") {
      const run = ev.run;
      setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)].sort(newestFirst));
      if (run.status === "done" && run.finishedAt && Date.now() - run.finishedAt < 3000) {
        const msg = run.kind === "thesis"
          ? `${run.drafted.length} thesis answer${run.drafted.length === 1 ? "" : "s"} drafted`
          : run.kind === "map" ? "Buying committee mapped" : `Discovery found ${run.ready} compan${run.ready === 1 ? "y" : "ies"} to review`;
        toast.success(msg, { id: `discovery-${run.id}` });
      }
      if (run.status === "failed" && run.error) toast.error(run.error, { id: `discovery-${run.id}` });
    } else if (ev.type === "candidates") {
      setCandidates((prev) => withCandidates(prev, ev.candidates));
    } else if (ev.type === "thesis") {
      // The server drafted answers: the user's own typing (sent or waiting to be) wins over them.
      setThesis((t: Thesis | null) => {
        if (!t) return ev.thesis;
        const answers = { ...ev.thesis.answers };
        const drafted = new Set(ev.thesis.drafted);
        for (const [qid, v] of [...inflight.current, ...pending.current]) {
          if (v === null) delete answers[qid];
          else answers[qid] = v;
          drafted.delete(qid);
        }
        return { ...ev.thesis, answers, drafted: ev.thesis.drafted.filter((d) => drafted.has(d)) };
      });
    }
  }, [setThesis]));

  // ----- runs -----
  const { withConsent } = consent;
  const start = useCallback(async (body: StartDiscoveryBody) => {
    await state.flush();
    await flushThesis();
    const run = await withConsent(() => api.startDiscovery(id, body));
    if (run) setRuns((prev) => withRun(prev, run));
    return run;
  }, [flushThesis, id, state, withConsent]);

  const action = useCallback(async (runId: string, a: "pause" | "resume" | "stop") => {
    const run = await api.discoveryAction(runId, a).catch((e) => {
      toast.error(e.message);
      return null;
    });
    if (run) setRuns((prev) => withRun(prev, run));
  }, []);

  // ----- the inbox -----
  const accept = useCallback(async (picks: { id: string; contactIds: string[] }[]) => {
    if (!picks.length) return null;
    await state.flush();
    try {
      const res = await api.acceptCandidates(id, picks);
      replaceCampaign(res.campaign);
      applyRemoteRows(res.rows);
      setCandidates((prev) => withCandidates(prev, res.candidates));
      const added = res.candidates.filter((c) => c.status === "accepted").length;
      const dupes = res.candidates.length - added;
      const people = res.rows.filter((r) => r.parentId).length;
      if (added) toast.success(`Added ${added} prospect${added === 1 ? "" : "s"} with ${people} contact${people === 1 ? "" : "s"}${dupes ? ` · ${dupes} already in the list` : ""}`);
      else if (dupes) toast(`${dupes === 1 ? "That company is" : "Those companies are"} already in the list.`);
      return res;
    } catch (err) {
      toast.error((err as Error).message);
      return null;
    }
  }, [applyRemoteRows, id, replaceCampaign, state]);

  const dismiss = useCallback(async (ids: string[], reason: string | null) => {
    const changed = await api.dismissCandidates(id, ids, reason).catch((e) => {
      toast.error(e.message);
      return [] as Candidate[];
    });
    setCandidates((prev) => withCandidates(prev, changed));
  }, [id]);

  const restore = useCallback(async (ids: string[]) => {
    const changed = await api.restoreCandidates(id, ids).catch((e) => {
      toast.error(e.message);
      return [] as Candidate[];
    });
    setCandidates((prev) => withCandidates(prev, changed));
  }, [id]);

  const inbox = useMemo(() => candidates.filter((c) => c.status === "ready" || c.status === "mapping" || c.status === "error").sort(inboxOrder), [candidates]);
  const dismissed = useMemo(() => candidates.filter((c) => c.status === "dismissed").sort((a, b) => b.updatedAt - a.updatedAt), [candidates]);
  const activeRuns = useMemo(() => runs.filter((r) => isLiveStatus(r.status)), [runs]);

  return {
    /** True for a Discovery campaign (one with a thesis). */
    enabled: !!thesis,
    thesis, setAnswer, keepDraft, flushThesis,
    runs, activeRuns, start, action,
    candidates, inbox, dismissed, accept, dismiss, restore,
  };
}

export type DiscoveryState = ReturnType<typeof useDiscovery>;
