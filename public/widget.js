/**
 * VestFlow Vesting Widget
 * 
 * Embeddable web component showing a beneficiary's vesting status
 * Usage:
 * <script src="https://vestflow.xyz/widget.js"></script>
 * <vestflow-widget schedule-id="123" minimal="false"></vestflow-widget>
 */

interface VestFlowSchedule {
  id: number;
  grantor: string;
  beneficiary: string;
  token: string;
  total_amount: string;
  claimed: string;
  start_time: number;
  duration: number;
  cliff_duration: number;
  kind: string;
  revocable: boolean;
  revoked: boolean;
}

interface WidgetData {
  schedule: VestFlowSchedule;
  claimable: string;
  network: string;
}

class VestFlowWidget extends HTMLElement {
  private scheduleId: string | null = null;
  private minimal: boolean = false;
  private data: WidgetData | null = null;
  private shadow: ShadowRoot | null = null;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.scheduleId = this.getAttribute("schedule-id");
    this.minimal = this.getAttribute("minimal") === "true";

    if (!this.scheduleId) {
      this.renderError("Missing schedule-id attribute");
      return;
    }

    this.loadAndRender();
  }

  private async loadAndRender() {
    try {
      const response = await fetch(
        `${this.getWidgetApiUrl()}/api/schedules/${this.scheduleId}`
      );

      if (!response.ok) {
        this.renderError("Schedule not found");
        return;
      }

      this.data = await response.json();
      this.render();
    } catch (error) {
      this.renderError("Failed to load schedule data");
      console.error("VestFlow Widget Error:", error);
    }
  }

  private getWidgetApiUrl(): string {
    // Try to detect the origin from the script tag
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      if (script.src?.includes("vestflow")) {
        return new URL(".", script.src).toString().slice(0, -1);
      }
    }
    // Fallback to common domains
    if (typeof window !== "undefined") {
      if (window.location.hostname === "localhost") {
        return "http://localhost:3000";
      }
    }
    return "https://vestflow.xyz";
  }

  private render() {
    if (!this.data) return;

    const schedule = this.data.schedule;
    const now = Math.floor(Date.now() / 1000);
    const endTime = schedule.start_time + schedule.duration;
    const progress = schedule.duration <= 0
      ? (now >= schedule.start_time ? 100 : 0)
      : Math.max(
          0,
          Math.min(100, ((now - schedule.start_time) / schedule.duration) * 100)
        );

    const formatAmount = (amount: string) => {
      const num = Number(amount) / 10_000_000;
      return num.toFixed(2);
    };

    const isFullyVested = now >= endTime && !schedule.revoked;
    const isVesting = now >= schedule.start_time && now < endTime && !schedule.revoked;
    const isRevoked = schedule.revoked;

    let status = "Not Started";
    let statusColor = "#f59e0b";
    if (isRevoked) {
      status = "Revoked";
      statusColor = "#ef4444";
    } else if (isFullyVested) {
      status = "Fully Vested";
      statusColor = "#10b981";
    } else if (isVesting) {
      status = "Vesting";
      statusColor = "#3b82f6";
    }

    const html = this.minimal
      ? this.renderMinimal(schedule, progress, status, statusColor, formatAmount)
      : this.renderFull(schedule, progress, status, statusColor, formatAmount);

    if (this.shadow) {
      this.shadow.innerHTML = `
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          :host {
            font-family: system-ui, -apple-system, sans-serif;
            display: block;
            --primary: #a78bfa;
            --primary-dark: #7c3aed;
            --bg-primary: #18181b;
            --bg-secondary: #27272a;
            --bg-tertiary: #3f3f46;
            --text-primary: #fafafa;
            --text-secondary: #a1a1aa;
            --border: #52525b;
          }

          .widget {
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px;
            color: var(--text-primary);
            max-width: 100%;
            width: 100%;
          }

          .widget.minimal {
            padding: 12px;
            background: var(--bg-secondary);
          }

          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
          }

          .title {
            font-size: 16px;
            font-weight: 600;
          }

          .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            border: 1px solid;
            color: ${statusColor};
            border-color: ${statusColor}40;
            background: ${statusColor}10;
          }

          .amount-display {
            margin-bottom: 16px;
          }

          .amount-label {
            font-size: 12px;
            color: var(--text-secondary);
            margin-bottom: 4px;
          }

          .amount-value {
            font-size: 28px;
            font-weight: 700;
            font-family: monospace;
            color: var(--primary);
          }

          .progress-section {
            margin-bottom: 16px;
          }

          .progress-label {
            display: flex;
            justify-content: space-between;
            font-size: 12px;
            color: var(--text-secondary);
            margin-bottom: 8px;
          }

          .progress-bar {
            width: 100%;
            height: 8px;
            background: var(--bg-tertiary);
            border-radius: 4px;
            overflow: hidden;
          }

          .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--primary), var(--primary-dark));
            width: ${progress}%;
            transition: width 0.3s ease;
          }

          .details {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            font-size: 12px;
            padding: 12px;
            background: var(--bg-secondary);
            border-radius: 8px;
            margin-bottom: 12px;
          }

          .detail-item {
            display: flex;
            flex-direction: column;
          }

          .detail-label {
            color: var(--text-secondary);
            margin-bottom: 2px;
          }

          .detail-value {
            color: var(--text-primary);
            font-weight: 500;
            font-family: monospace;
          }

          .footer {
            text-align: center;
            font-size: 11px;
            color: var(--text-secondary);
            margin-top: 12px;
          }

          a {
            color: var(--primary);
            text-decoration: none;
            transition: color 0.2s;
          }

          a:hover {
            color: var(--primary-dark);
          }

          .minimal .details {
            display: none;
          }

          .minimal .amount-display {
            margin-bottom: 12px;
          }

          .minimal .amount-value {
            font-size: 20px;
          }

          .minimal .progress-section {
            margin-bottom: 12px;
          }
        </style>
        ${html}
      `;
    }
  }

  private renderMinimal(
    schedule: VestFlowSchedule,
    progress: number,
    status: string,
    statusColor: string,
    formatAmount: (amount: string) => string
  ): string {
    return `
      <div class="widget minimal">
        <div class="header">
          <div class="title">Schedule #${schedule.id}</div>
          <div class="status-badge">${status}</div>
        </div>
        
        <div class="amount-display">
          <div class="amount-label">Vesting</div>
          <div class="amount-value">${formatAmount(schedule.total_amount)} XLM</div>
        </div>

        <div class="progress-section">
          <div class="progress-label">
            <span>Progress</span>
            <span>${progress.toFixed(0)}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill"></div>
          </div>
        </div>

        <div class="footer">
          <a href="${this.getWidgetApiUrl()}/schedule/${schedule.id}" target="_blank">
            View full details →
          </a>
        </div>
      </div>
    `;
  }

  private renderFull(
    schedule: VestFlowSchedule,
    progress: number,
    status: string,
    statusColor: string,
    formatAmount: (amount: string) => string
  ): string {
    const claimed = formatAmount(schedule.claimed);
    const remaining = formatAmount(
      String(BigInt(schedule.total_amount) - BigInt(schedule.claimed))
    );

    return `
      <div class="widget">
        <div class="header">
          <div class="title">VestFlow Schedule #${schedule.id}</div>
          <div class="status-badge">${status}</div>
        </div>
        
        <div class="amount-display">
          <div class="amount-label">Total Amount</div>
          <div class="amount-value">${formatAmount(schedule.total_amount)} XLM</div>
        </div>

        <div class="progress-section">
          <div class="progress-label">
            <span>Vesting Progress</span>
            <span>${progress.toFixed(1)}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill"></div>
          </div>
        </div>

        <div class="details">
          <div class="detail-item">
            <div class="detail-label">Claimed</div>
            <div class="detail-value">${claimed} XLM</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Remaining</div>
            <div class="detail-value">${remaining} XLM</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Type</div>
            <div class="detail-value">${schedule.kind}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Revocable</div>
            <div class="detail-value">${schedule.revocable ? "Yes" : "No"}</div>
          </div>
        </div>

        <div class="footer">
          <a href="${this.getWidgetApiUrl()}/schedule/${schedule.id}" target="_blank">
            View full schedule →
          </a>
        </div>
      </div>
    `;
  }

  private renderError(message: string) {
    const html = `
      <style>
        :host {
          font-family: system-ui, -apple-system, sans-serif;
          display: block;
        }

        .error {
          background: #7f1d1d;
          border: 1px solid #dc2626;
          border-radius: 8px;
          padding: 16px;
          color: #fecaca;
          font-size: 14px;
          text-align: center;
        }

        a {
          color: #fca5a5;
          text-decoration: underline;
        }
      </style>
      <div class="error">
        <strong>VestFlow Widget Error:</strong> ${message}
        <br>
        <small>
          <a href="https://docs.vestflow.xyz/widget" target="_blank">
            Learn how to embed
          </a>
        </small>
      </div>
    `;

    if (this.shadow) {
      this.shadow.innerHTML = html;
    }
  }
}

// Register the custom element
if (typeof customElements !== "undefined" && !customElements.get("vestflow-widget")) {
  customElements.define("vestflow-widget", VestFlowWidget);
}
