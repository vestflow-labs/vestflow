"use client";
import { useEffect, useState } from "react";
import {
  ScheduleData,
  RecoveryRequest,
  getRecoveryRequest,
  requestAdminRecovery,
  cancelAdminRecovery,
  executeAdminRecovery,
  parseContractError,
  formatDate,
} from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";

// 7-day timelock in seconds — mirrors RECOVERY_TIMELOCK_SECONDS in the contract
const RECOVERY_TIMELOCK_SECONDS = 7 * 24 * 60 * 60;

interface Props {
  schedule: ScheduleData;
  /** Called after any state-changing action so the parent can refresh. */
  onAction: () => void;
}

export default function AdminRecovery({ schedule, onAction }: Props) {
  const { publicKey } = useWallet();
  const [request, setRequest] = useState<RecoveryRequest | null>(null);
  const [loadingRequest, setLoadingRequest] = useState(true);
  const [newBeneficiary, setNewBeneficiary] = useState("");
  const [actionLoading, setActionLoading] = useState<
    "file" | "cancel" | "execute" | null
  >(null);
  const [err, setErr] = useState("");
  const [success, setSuccess] = useState("");
  const [expanded, setExpanded] = useState(false);

  const isGrantor = publicKey === schedule.grantor;
  // The upgrade authority address is not exposed client-side; we optimistically
  // allow the execute button and let the contract reject unauthorised calls.
  const canExecute = !!publicKey;
  const canCancel = !!publicKey;

  const loadRequest = async () => {
    setLoadingRequest(true);
    try {
      const r = await getRecoveryRequest(schedule.id, publicKey ?? undefined);
      setRequest(r);
    } finally {
      setLoadingRequest(false);
    }
  };

  useEffect(() => {
    if (expanded) loadRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, schedule.id]);

  const now = Math.floor(Date.now() / 1000);
  const timelockExpired = request ? now >= request.executable_at : false;
  const secondsRemaining = request
    ? Math.max(0, request.executable_at - now)
    : 0;

  const formatCountdown = (secs: number) => {
    const days = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h remaining`;
    if (hours > 0) return `${hours}h ${mins}m remaining`;
    return `${mins}m remaining`;
  };

  const handleFileRequest = async () => {
    if (!publicKey || !newBeneficiary.trim()) return;
    setActionLoading("file");
    setErr("");
    setSuccess("");
    try {
      await requestAdminRecovery(publicKey, schedule.id, newBeneficiary.trim());
      setSuccess("Recovery request filed. The 7-day timelock has started.");
      setNewBeneficiary("");
      await loadRequest();
      onAction();
    } catch (e: any) {
      setErr(parseContractError(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancel = async () => {
    if (!publicKey) return;
    setActionLoading("cancel");
    setErr("");
    setSuccess("");
    try {
      await cancelAdminRecovery(publicKey, schedule.id);
      setSuccess("Recovery request cancelled.");
      setRequest(null);
      onAction();
    } catch (e: any) {
      setErr(parseContractError(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleExecute = async () => {
    if (!publicKey) return;
    setActionLoading("execute");
    setErr("");
    setSuccess("");
    try {
      await executeAdminRecovery(publicKey, schedule.id);
      setSuccess("Recovery executed. Beneficiary has been redirected.");
      setRequest(null);
      onAction();
    } catch (e: any) {
      setErr(parseContractError(e));
    } finally {
      setActionLoading(null);
    }
  };

  if (schedule.revoked) return null;

  return (
    <div className="border border-amber-500/20 bg-amber-500/5 rounded-xl overflow-hidden">
      {/* Header / toggle */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-amber-500/5 transition-colors"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <span className="text-amber-400 text-lg" aria-hidden>🔑</span>
          <div>
            <p className="text-sm font-semibold text-amber-300">
              Emergency Admin Recovery
            </p>
            <p className="text-xs text-zinc-400 mt-0.5">
              Redirect tokens when a beneficiary key is permanently lost
            </p>
          </div>
        </div>
        <span className="text-zinc-500 text-sm">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="px-5 pb-5 border-t border-amber-500/10 pt-4 flex flex-col gap-4">
          {/* Explainer */}
          <div className="text-xs text-zinc-400 space-y-1 leading-relaxed">
            <p>
              If the beneficiary&apos;s private key is permanently inaccessible,
              the <strong className="text-zinc-300">grantor</strong> can file a
              recovery request to redirect unvested tokens to a new address.
            </p>
            <p>
              A <strong className="text-zinc-300">7-day public timelock</strong>{" "}
              starts on filing. The beneficiary can use this window to prove
              their key is accessible. After 7 days, the{" "}
              <strong className="text-zinc-300">upgrade authority</strong> executes
              the redirect.
            </p>
          </div>

          {loadingRequest ? (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <div className="animate-spin rounded-full h-3 w-3 border-b border-zinc-400" />
              Checking recovery status…
            </div>
          ) : request ? (
            /* ---- Active request panel ---- */
            <div className="flex flex-col gap-3">
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4 text-sm space-y-2">
                <p className="font-semibold text-amber-300 flex items-center gap-2">
                  <span aria-hidden>⏳</span> Recovery request pending
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-zinc-500 mb-0.5">Filed by (grantor)</p>
                    <p className="font-mono text-zinc-300 break-all">
                      {request.requested_by}
                    </p>
                  </div>
                  <div>
                    <p className="text-zinc-500 mb-0.5">New beneficiary</p>
                    <p className="font-mono text-zinc-300 break-all">
                      {request.new_beneficiary}
                    </p>
                  </div>
                  <div>
                    <p className="text-zinc-500 mb-0.5">Filed at</p>
                    <p className="text-zinc-300">{formatDate(request.requested_at)}</p>
                  </div>
                  <div>
                    <p className="text-zinc-500 mb-0.5">Executable after</p>
                    <p className="text-zinc-300">
                      {formatDate(request.executable_at)}
                    </p>
                  </div>
                </div>
                {!timelockExpired && (
                  <p className="text-amber-400 text-xs font-medium">
                    ⏱ {formatCountdown(secondsRemaining)}
                  </p>
                )}
                {timelockExpired && (
                  <p className="text-green-400 text-xs font-medium">
                    ✓ Timelock expired — ready to execute
                  </p>
                )}
              </div>

              <div className="flex gap-2 flex-wrap">
                {/* Execute — only shown once timelock has passed */}
                {timelockExpired && canExecute && (
                  <button
                    onClick={handleExecute}
                    disabled={!!actionLoading}
                    className="text-xs rounded-lg px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-semibold transition-colors disabled:opacity-60"
                  >
                    {actionLoading === "execute"
                      ? "Processing…"
                      : "Execute Recovery"}
                  </button>
                )}

                {/* Cancel — available to grantor or authority during the window */}
                {canCancel && (
                  <button
                    onClick={handleCancel}
                    disabled={!!actionLoading}
                    className="text-xs rounded-lg px-3 py-1.5 border border-red-500/30 text-red-400 hover:border-red-500/60 transition-colors disabled:opacity-60"
                  >
                    {actionLoading === "cancel" ? "Processing…" : "Cancel Request"}
                  </button>
                )}
              </div>
            </div>
          ) : (
            /* ---- No active request — show the filing form ---- */
            isGrantor ? (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-zinc-400">
                    New beneficiary address
                  </span>
                  <input
                    type="text"
                    value={newBeneficiary}
                    onChange={(e) => setNewBeneficiary(e.target.value)}
                    placeholder="G…"
                    className="input font-mono text-sm"
                    aria-label="New beneficiary Stellar address"
                  />
                  <span className="text-xs text-zinc-500">
                    Tokens will be redirectable to this address after the 7-day timelock.
                  </span>
                </label>

                <button
                  onClick={handleFileRequest}
                  disabled={!newBeneficiary.trim() || !!actionLoading}
                  className="self-start text-sm rounded-lg px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-semibold transition-colors disabled:opacity-60"
                >
                  {actionLoading === "file"
                    ? "Filing request…"
                    : "File Recovery Request"}
                </button>
              </div>
            ) : (
              <p className="text-xs text-zinc-500">
                No recovery request is currently pending for this schedule.
                Only the grantor can file a new request.
              </p>
            )
          )}

          {err && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {err}
            </p>
          )}
          {success && (
            <p className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
              {success}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
