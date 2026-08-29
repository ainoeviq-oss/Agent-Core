import { useEffect, useMemo, useRef, useState } from 'react';
import { bridge, type SelectedPresentation } from './bridge.js';
import type { ApplicationJobSnapshot, BridgeDoctorResult, JobHistoryItem } from '../../src/application/contracts.js';
import type { ConversionProgressEvent, JobTarget, TargetResult } from '../../src/types/contracts.js';

type View = 'convert' | 'history' | 'settings';

const terminalStates = new Set(['completed', 'completed_with_warnings', 'failed', 'cancelled']);

function Icon({ name }: { name: 'convert' | 'history' | 'settings' | 'file' | 'google' | 'keynote' | 'check' | 'warning' | 'folder' | 'external' | 'close' }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (name === 'convert') return <svg {...common}><path d="M5 7h11"/><path d="m13 4 3 3-3 3"/><path d="M19 17H8"/><path d="m11 14-3 3 3 3"/></svg>;
  if (name === 'history') return <svg {...common}><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/><path d="M12 7v5l3 2"/></svg>;
  if (name === 'settings') return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"/></svg>;
  if (name === 'file') return <svg {...common}><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5"/><path d="M10 13h5M10 17h5"/></svg>;
  if (name === 'google') return <svg {...common}><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v5h4"/><path d="M10 12h6v5h-6z"/></svg>;
  if (name === 'keynote') return <svg {...common}><rect x="4" y="4" width="16" height="11" rx="2"/><path d="M12 15v5M8 20h8"/><path d="m9 11 2-2 2 2 2-3"/></svg>;
  if (name === 'check') return <svg {...common}><path d="m5 12 4 4L19 6"/></svg>;
  if (name === 'warning') return <svg {...common}><path d="M12 3 2.7 20h18.6L12 3Z"/><path d="M12 9v4M12 17h.01"/></svg>;
  if (name === 'folder') return <svg {...common}><path d="M3 6h7l2 2h9v11H3z"/></svg>;
  if (name === 'external') return <svg {...common}><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 13v6H5V5h6"/></svg>;
  return <svg {...common}><path d="m6 6 12 12M18 6 6 18"/></svg>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function humanState(state: string): string {
  return state.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function targetStatus(result: TargetResult | undefined): { label: string; kind: 'good' | 'warn' | 'bad' | 'muted' } {
  if (!result) return { label: 'Not requested', kind: 'muted' };
  if (result.native && result.verification === 'live') return { label: 'Native verified', kind: 'good' };
  if (result.status === 'failed' || result.status === 'unavailable') return { label: humanState(result.status), kind: 'bad' };
  if (result.verification === 'mock') return { label: 'Simulation only', kind: 'warn' };
  return { label: humanState(result.status), kind: 'warn' };
}

function PlatformDot({ ready }: { ready: boolean }) {
  return <span className={`platform-dot ${ready ? 'ready' : 'pending'}`} />;
}

export default function App() {
  const [view, setView] = useState<View>('convert');
  const [source, setSource] = useState<SelectedPresentation | null>(null);
  const [target, setTarget] = useState<JobTarget>(() => (localStorage.getItem('pb.defaultTarget') as JobTarget | null) ?? 'all');
  const [outputRoot, setOutputRoot] = useState<string>(() => localStorage.getItem('pb.outputRoot') ?? '');
  const [doctor, setDoctor] = useState<BridgeDoctorResult | null>(null);
  const [history, setHistory] = useState<JobHistoryItem[]>([]);
  const [job, setJob] = useState<ApplicationJobSnapshot | null>(null);
  const [events, setEvents] = useState<ConversionProgressEvent[]>([]);
  const [error, setError] = useState<string>('');
  const [loadingDoctor, setLoadingDoctor] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const currentJobId = useRef<string | null>(null);

  const refreshDoctor = async () => {
    setLoadingDoctor(true);
    try { setDoctor(await bridge.doctor()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoadingDoctor(false); }
  };
  const refreshHistory = async () => {
    try { setHistory(await bridge.listHistory()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  useEffect(() => {
    void refreshDoctor();
    void refreshHistory();
    const unsubscribe = bridge.onProgress((event) => {
      if (event.jobId !== currentJobId.current) return;
      setEvents((previous) => [...previous.slice(-39), event]);
      setJob((previous) => previous ? {
        ...previous,
        state: event.stage,
        percent: event.percent,
        message: event.message,
        updatedAt: event.at
      } : previous);
      if (terminalStates.has(event.stage)) {
        void bridge.getJob(event.jobId).then((snapshot) => snapshot && setJob(snapshot));
        void refreshHistory();
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    localStorage.setItem('pb.defaultTarget', target);
  }, [target]);

  const googleReady = doctor?.google.liveAuth === true && doctor?.google.importCapability === true;
  const googleConfigured = doctor?.google.credentialsPresent === true;
  const keynoteReady = doctor?.keynote.available === true;
  const isActive = Boolean(job && !terminalStates.has(job.state));
  const canConvert = Boolean(source && !isActive);
  const terminalReport = job?.report;
  const reportPath = terminalReport?.artifacts.find((artifact) => artifact.endsWith('compatibility-report.html'));

  const selectPresentation = async () => {
    setError('');
    if (bridge.surface === 'hosted') {
      fileInput.current?.click();
      return;
    }
    try {
      const selected = await bridge.selectPresentation();
      if (selected) { setSource(selected); setJob(null); setEvents([]); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const selectHostedFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pptx')) {
      setError('Only .pptx PowerPoint presentations are supported.');
      return;
    }
    setSource({ name: file.name, bytes: file.size, file });
    setJob(null);
    setEvents([]);
    setError('');
  };

  const chooseOutput = async () => {
    try {
      const selected = await bridge.selectOutputDirectory();
      if (selected) {
        setOutputRoot(selected);
        localStorage.setItem('pb.outputRoot', selected);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const startConversion = async () => {
    if (!source) return;
    setError('');
    setEvents([]);
    try {
      const accepted = await bridge.startConversion({ source, target, ...(outputRoot ? { outputRoot } : {}) });
      currentJobId.current = accepted.jobId;
      const snapshot = await bridge.getJob(accepted.jobId);
      setJob(snapshot ?? {
        jobId: accepted.jobId,
        state: 'queued',
        percent: 0,
        message: 'Conversion queued.',
        updatedAt: new Date().toISOString()
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const cancelConversion = async () => {
    if (!job) return;
    try { await bridge.cancel(job.jobId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const connectGoogle = async () => {
    setError('');
    setAuthorizing(true);
    try {
      await bridge.authorizeGoogle();
      await refreshDoctor();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAuthorizing(false); }
  };

  const platformAdvice = useMemo(() => {
    if (target === 'google' && !googleReady) return googleConfigured ? 'Google authorization is required before native conversion.' : 'Google OAuth is not provisioned in this build.';
    if (target === 'keynote' && !keynoteReady) return 'Native Keynote conversion needs a compatible macOS Keynote worker.';
    if (target === 'all' && (!googleReady || !keynoteReady)) return 'Unavailable targets will be reported honestly; available targets can still complete.';
    return '';
  }, [target, googleReady, googleConfigured, keynoteReady]);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">PB</div>
        <div><strong>Presentation</strong><span>Bridge</span></div>
      </div>
      <nav className="nav-list" aria-label="Primary navigation">
        {([
          ['convert', 'Convert', 'convert'],
          ['history', 'History', 'history'],
          ['settings', 'Settings', 'settings']
        ] as const).map(([key, label, icon]) => <button key={key} className={view === key ? 'nav-item active' : 'nav-item'} onClick={() => setView(key)}><Icon name={icon}/><span>{label}</span></button>)}
      </nav>
      <div className="sidebar-status">
        <div className="status-line"><PlatformDot ready={googleReady}/><span>Google Slides</span><small>{googleReady ? 'Ready' : 'Setup'}</small></div>
        <div className="status-line"><PlatformDot ready={keynoteReady}/><span>Keynote</span><small>{keynoteReady ? 'Ready' : 'Worker'}</small></div>
      </div>
      <div className="sidebar-footer"><span>{bridge.surface === 'desktop' ? 'Desktop' : 'Browser'} surface</span><small>v0.2.0</small></div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <div>
          <h1>{view === 'convert' ? 'Convert presentation' : view === 'history' ? 'Conversion history' : 'Settings & diagnostics'}</h1>
          <p>{view === 'convert' ? 'PowerPoint in. Native target out. Evidence included.' : view === 'history' ? 'Review native results, warnings, and compatibility reports.' : 'Configure the local workflow and verify platform readiness.'}</p>
        </div>
        <button className="icon-button" onClick={() => void refreshDoctor()} title="Refresh diagnostics" aria-label="Refresh diagnostics"><span className={loadingDoctor ? 'refresh-spinner spinning' : 'refresh-spinner'}>↻</span></button>
      </header>

      {error && <div className="error-banner"><Icon name="warning"/><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><Icon name="close"/></button></div>}

      {view === 'convert' && <section className="content-stack">
        <div className="workspace-grid">
          <section className="panel source-panel">
            <div className="panel-heading"><span>01</span><div><h2>PowerPoint source</h2><p>Select one presentation to inspect and convert.</p></div></div>
            <button className={source ? 'dropzone selected' : 'dropzone'} onClick={() => void selectPresentation()}>
              <span className="file-icon"><Icon name="file"/></span>
              {source ? <><strong>{source.name}</strong><span>{formatBytes(source.bytes)} · PPTX</span><em>Choose a different file</em></> : <><strong>Select PowerPoint</strong><span>.pptx up to the configured security limit</span><em>{bridge.surface === 'desktop' ? 'Browse files' : 'Choose upload'}</em></>}
            </button>
            <input ref={fileInput} className="hidden-input" type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" onChange={(event) => selectHostedFile(event.target.files?.[0])}/>
            {bridge.surface === 'desktop' && <div className="output-row"><div><span>Output location</span><strong>{outputRoot || 'Presentation Bridge runtime'}</strong></div><button className="ghost-button" onClick={() => void chooseOutput()}><Icon name="folder"/>Choose</button></div>}
          </section>

          <section className="panel target-panel">
            <div className="panel-heading"><span>02</span><div><h2>Native target</h2><p>Choose where the PowerPoint should become editable.</p></div></div>
            <div className="target-options">
              <button className={target === 'google' ? 'target-card selected google' : 'target-card google'} onClick={() => setTarget('google')}>
                <span className="target-icon"><Icon name="google"/></span><div><strong>Google Slides</strong><small>Native Drive presentation</small></div><span className="target-ready"><PlatformDot ready={googleReady}/>{googleReady ? 'Ready' : 'Setup'}</span>
              </button>
              <button className={target === 'keynote' ? 'target-card selected keynote' : 'target-card keynote'} onClick={() => setTarget('keynote')}>
                <span className="target-icon"><Icon name="keynote"/></span><div><strong>Keynote</strong><small>Native .key document</small></div><span className="target-ready"><PlatformDot ready={keynoteReady}/>{keynoteReady ? 'Ready' : 'Worker'}</span>
              </button>
              <button className={target === 'all' ? 'target-card selected both' : 'target-card both'} onClick={() => setTarget('all')}>
                <span className="target-icon dual"><Icon name="google"/><Icon name="keynote"/></span><div><strong>Both targets</strong><small>Independent native paths</small></div><span className="target-ready">Evidence for both</span>
              </button>
            </div>
            {platformAdvice && <div className="advice"><Icon name="warning"/><span>{platformAdvice}</span></div>}
            {!googleReady && googleConfigured && <button className="secondary-button auth-button" disabled={authorizing} onClick={() => void connectGoogle()}>{authorizing ? 'Waiting for browser authorization…' : 'Connect Google account'}</button>}
          </section>
        </div>

        <section className="action-panel">
          <div><span className="action-kicker">03 · Convert</span><h2>{source ? source.name : 'Ready when your presentation is selected'}</h2><p>The converter will preflight the PPTX, use the native target path, verify the result, and produce compatibility evidence.</p></div>
          <button className="primary-button" disabled={!canConvert} onClick={() => void startConversion()}><Icon name="convert"/>{isActive ? 'Conversion running' : 'Convert presentation'}</button>
        </section>

        {job && <section className="progress-panel">
          <div className="progress-head"><div><span className={`state-pill ${terminalStates.has(job.state) ? job.state : 'active'}`}>{humanState(job.state)}</span><h2>{job.message}</h2></div><strong>{job.percent}%</strong></div>
          <div className="progress-track"><div className="progress-fill" style={{ width: `${job.percent}%` }}/></div>
          <div className="stage-row">
            {['Preflight', 'Google', 'Keynote', 'Verification', 'Report'].map((label, index) => <span key={label} className={job.percent >= [10,35,60,82,100][index]! ? 'stage done' : 'stage'}><i>{job.percent >= [10,35,60,82,100][index]! ? '✓' : index + 1}</i>{label}</span>)}
          </div>
          {isActive && <div className="progress-actions"><button className="danger-button" onClick={() => void cancelConversion()}>Cancel conversion</button><small>Cancellation is applied at safe conversion boundaries.</small></div>}
          {events.length > 0 && <details className="event-log"><summary>Process log · {events.length} events</summary><div>{events.map((event, index) => <p key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString()}</time><span>{humanState(event.stage)}</span>{event.message}</p>)}</div></details>}
        </section>}

        {terminalReport && <section className="result-panel">
          <div className="result-title"><div><span className="result-check"><Icon name={terminalReport.status === 'failed' ? 'warning' : 'check'}/></span><div><h2>Conversion evidence ready</h2><p>{terminalReport.warnings.length ? `${terminalReport.warnings.length} warning${terminalReport.warnings.length === 1 ? '' : 's'} recorded. Nothing was silently promoted to success.` : 'All requested live checks completed without warnings.'}</p></div></div>{reportPath && <button className="ghost-button" onClick={() => void bridge.openReport({ jobId: terminalReport.jobId, htmlReportPath: reportPath })}>Open report<Icon name="external"/></button>}</div>
          <div className="result-grid">
            {(['google','keynote'] as const).map((name) => {
              const result = terminalReport.targets[name];
              const status = targetStatus(result);
              return <div className="result-card" key={name}><span className={`target-icon ${name}`}><Icon name={name}/></span><div><strong>{name === 'google' ? 'Google Slides' : 'Keynote'}</strong><span className={`result-status ${status.kind}`}>{status.label}</span></div>{result?.webViewLink && <button onClick={() => void bridge.openExternal(result.webViewLink!)}><Icon name="external"/></button>}{result?.artifact && bridge.surface === 'desktop' && <button onClick={() => void bridge.revealArtifact(result.artifact!)}><Icon name="folder"/></button>}</div>;
            })}
          </div>
        </section>}
      </section>}

      {view === 'history' && <section className="history-view">
        <div className="history-toolbar"><span>{history.length} recorded job{history.length === 1 ? '' : 's'}</span><button className="ghost-button" onClick={() => void refreshHistory()}>Refresh</button></div>
        <div className="history-list">
          {history.length === 0 && <div className="empty-state"><Icon name="history"/><h2>No conversion history yet</h2><p>Your verified jobs will appear here.</p><button className="secondary-button" onClick={() => setView('convert')}>Start a conversion</button></div>}
          {history.map((item) => <article className="history-row" key={item.jobId}>
            <span className="history-file"><Icon name="file"/></span>
            <div className="history-main"><strong>{item.sourceFilename ?? item.jobId}</strong><span>{item.finishedAt ? new Date(item.finishedAt).toLocaleString() : new Date(item.updatedAt).toLocaleString()}</span></div>
            <span className={`state-pill ${item.state}`}>{humanState(item.state)}</span>
            <div className="history-targets"><span>G {item.targets?.google?.native ? '✓' : '—'}</span><span>K {item.targets?.keynote?.native ? '✓' : '—'}</span></div>
            {item.htmlReportPath && <button className="icon-button" title="Open compatibility report" onClick={() => void bridge.openReport(item)}><Icon name="external"/></button>}
          </article>)}
        </div>
      </section>}

      {view === 'settings' && <section className="settings-view">
        <div className="settings-grid">
          <section className="panel settings-card"><div className="panel-heading plain"><div><h2>Default conversion</h2><p>Choose the target preselected when the app opens.</p></div></div><div className="segmented">{(['google','keynote','all'] as JobTarget[]).map((value) => <button key={value} className={target === value ? 'selected' : ''} onClick={() => setTarget(value)}>{value === 'all' ? 'Both' : value === 'google' ? 'Google Slides' : 'Keynote'}</button>)}</div>{bridge.surface === 'desktop' && <div className="setting-row"><div><strong>Output folder</strong><span>{outputRoot || 'Default runtime folder'}</span></div><button className="ghost-button" onClick={() => void chooseOutput()}>Change</button></div>}</section>
          <section className="panel settings-card"><div className="panel-heading plain"><div><h2>Google Slides</h2><p>System-browser OAuth. Tokens remain local to this app state.</p></div></div><div className="readiness-row"><div><PlatformDot ready={googleReady}/><strong>{googleReady ? 'Connected and import-ready' : googleConfigured ? 'Authorization required' : 'OAuth client not provisioned'}</strong></div>{googleConfigured && !googleReady && <button className="secondary-button" disabled={authorizing} onClick={() => void connectGoogle()}>Connect</button>}</div></section>
          <section className="panel settings-card"><div className="panel-heading plain"><div><h2>Keynote worker</h2><p>Native Keynote output requires macOS with Keynote automation available.</p></div></div><div className="readiness-row"><div><PlatformDot ready={keynoteReady}/><strong>{keynoteReady ? `Ready · ${String(doctor?.keynote.version ?? 'Keynote')}` : String(doctor?.keynote.reason ?? 'Worker unavailable')}</strong></div></div></section>
          <section className="panel settings-card diagnostics"><div className="panel-heading plain"><div><h2>Diagnostics</h2><p>Evidence from the same backend used for conversion.</p></div></div><dl><div><dt>Runtime</dt><dd>{doctor ? `${doctor.node} · ${doctor.platform}/${doctor.arch}` : 'Checking…'}</dd></div><div><dt>Isolation</dt><dd>{doctor?.isolation.clean ? 'Clean' : doctor ? 'Review required' : 'Checking…'}</dd></div><div><dt>Source renderer</dt><dd>{doctor?.sourceRenderer.available === true ? 'Available' : 'Optional / unavailable'}</dd></div><div><dt>Surface</dt><dd>{bridge.surface === 'desktop' ? 'Electron desktop' : 'Hosted browser'}</dd></div></dl><button className="secondary-button" onClick={() => void refreshDoctor()}>Run diagnostics</button></section>
        </div>
      </section>}
    </main>
  </div>;
}
