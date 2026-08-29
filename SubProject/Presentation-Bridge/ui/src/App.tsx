import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { bridge, type SelectedPresentation } from './bridge.js';
import type { ApplicationJobSnapshot, BridgeDoctorResult, JobHistoryItem } from '../../src/application/contracts.js';
import type { KeynoteWorkerSettingsInput, KeynoteWorkerSettingsView } from '../../src/application/settings-store.js';
import type { ConversionProgressEvent, JobTarget, TargetResult } from '../../src/types/contracts.js';

const terminalStates = new Set(['completed', 'completed_with_warnings', 'failed', 'cancelled']);
const targets: Array<{ value: JobTarget; title: string; description: string; icon: 'google' | 'keynote' | 'both' }> = [
  { value: 'google', title: 'Google Slides', description: 'Editable presentation in Drive', icon: 'google' },
  { value: 'keynote', title: 'Keynote', description: 'Native .key document', icon: 'keynote' },
  { value: 'all', title: 'Both', description: 'Create both native targets', icon: 'both' }
];

type IconName = 'convert' | 'history' | 'setup' | 'file' | 'google' | 'keynote' | 'check' | 'warning' | 'folder' | 'external' | 'close' | 'refresh';

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  };
  if (name === 'convert') return <svg {...common}><path d="M5 7h11"/><path d="m13 4 3 3-3 3"/><path d="M19 17H8"/><path d="m11 14-3 3 3 3"/></svg>;
  if (name === 'history') return <svg {...common}><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/><path d="M12 7v5l3 2"/></svg>;
  if (name === 'setup') return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19 12h2M3 12h2M12 3v2M12 19v2M17 7l1.5-1.5M5.5 18.5 7 17M17 17l1.5 1.5M5.5 5.5 7 7"/></svg>;
  if (name === 'file') return <svg {...common}><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5"/><path d="M10 13h5M10 17h5"/></svg>;
  if (name === 'google') return <svg {...common}><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v5h4"/><path d="M10 12h6v5h-6z"/></svg>;
  if (name === 'keynote') return <svg {...common}><rect x="4" y="4" width="16" height="11" rx="2"/><path d="M12 15v5M8 20h8"/><path d="m9 11 2-2 2 2 2-3"/></svg>;
  if (name === 'check') return <svg {...common}><path d="m5 12 4 4L19 6"/></svg>;
  if (name === 'warning') return <svg {...common}><path d="M12 3 2.7 20h18.6L12 3Z"/><path d="M12 9v4M12 17h.01"/></svg>;
  if (name === 'folder') return <svg {...common}><path d="M3 6h7l2 2h9v11H3z"/></svg>;
  if (name === 'external') return <svg {...common}><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 13v6H5V5h6"/></svg>;
  if (name === 'refresh') return <svg {...common}><path d="M20 6v5h-5"/><path d="M19 11a8 8 0 1 0 1 5"/></svg>;
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

function StatusDot({ ready }: { ready: boolean }) {
  return <span className={`status-dot ${ready ? 'ready' : 'pending'}`} />;
}

function Dialog({ open, title, onClose, children, wide = false }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  if (!open) return null;
  return <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
      <header className="dialog-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label={`Close ${title}`}><Icon name="close"/></button></header>
      {children}
    </section>
  </div>;
}

function ResultCard({ name, result }: { name: 'google' | 'keynote'; result: TargetResult | undefined }) {
  const status = targetStatus(result);
  return <article className="result-card">
    <span className={`platform-icon ${name}`}><Icon name={name}/></span>
    <div className="result-copy"><strong>{name === 'google' ? 'Google Slides' : 'Keynote'}</strong><span className={`result-status ${status.kind}`}>{status.label}</span></div>
    <div className="result-actions">
      {result?.webViewLink ? <button className="icon-button" onClick={() => void bridge.openExternal(result.webViewLink!)} aria-label="Open Google Slides"><Icon name="external"/></button> : null}
      {result?.artifact && bridge.surface === 'desktop' ? <button className="icon-button" onClick={() => void bridge.revealArtifact(result.artifact!)} aria-label="Show Keynote file"><Icon name="folder"/></button> : null}
    </div>
  </article>;
}

export default function App() {
  const [source, setSource] = useState<SelectedPresentation | null>(null);
  const [target, setTarget] = useState<JobTarget>(() => (localStorage.getItem('pb.defaultTarget') as JobTarget | null) ?? 'all');
  const [outputRoot, setOutputRoot] = useState(() => localStorage.getItem('pb.outputRoot') ?? '');
  const [doctor, setDoctor] = useState<BridgeDoctorResult | null>(null);
  const [history, setHistory] = useState<JobHistoryItem[]>([]);
  const [keynoteSettings, setKeynoteSettings] = useState<KeynoteWorkerSettingsView | null>(null);
  const [workerMode, setWorkerMode] = useState<'local' | 'remote'>('local');
  const [workerUrl, setWorkerUrl] = useState('');
  const [workerToken, setWorkerToken] = useState('');
  const [job, setJob] = useState<ApplicationJobSnapshot | null>(null);
  const [events, setEvents] = useState<ConversionProgressEvent[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [error, setError] = useState('');
  const [loadingDoctor, setLoadingDoctor] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const [savingWorker, setSavingWorker] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const currentJobId = useRef<string | null>(null);

  const refreshDoctor = async (): Promise<void> => {
    setLoadingDoctor(true);
    try { setDoctor(await bridge.doctor()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoadingDoctor(false); }
  };

  const refreshHistory = async (): Promise<void> => {
    try { setHistory(await bridge.listHistory()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const refreshKeynoteSettings = async (): Promise<void> => {
    if (bridge.surface !== 'desktop') return;
    try {
      const settings = await bridge.getKeynoteWorkerSettings();
      setKeynoteSettings(settings);
      setWorkerMode(settings.mode);
      setWorkerUrl(settings.url);
      setWorkerToken('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    void Promise.all([refreshDoctor(), refreshHistory(), refreshKeynoteSettings()]);
    const unsubscribe = bridge.onProgress((event) => {
      if (event.jobId !== currentJobId.current) return;
      setEvents((previous) => [...previous.slice(-29), event]);
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
  const report = job?.report;
  const htmlReportPath = report?.artifacts.find((artifact) => artifact.endsWith('compatibility-report.html'));

  const selectPresentation = async (): Promise<void> => {
    setError('');
    if (bridge.surface === 'hosted') {
      fileInput.current?.click();
      return;
    }
    try {
      const selected = await bridge.selectPresentation();
      if (selected) {
        setSource(selected);
        setJob(null);
        setEvents([]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const selectHostedFile = (file: File | undefined): void => {
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

  const chooseOutput = async (): Promise<void> => {
    try {
      const selected = await bridge.selectOutputDirectory();
      if (selected) {
        setOutputRoot(selected);
        localStorage.setItem('pb.outputRoot', selected);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const startConversion = async (): Promise<void> => {
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const cancelConversion = async (): Promise<void> => {
    if (!job) return;
    try { await bridge.cancel(job.jobId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const connectGoogle = async (): Promise<void> => {
    setError('');
    setAuthorizing(true);
    try {
      await bridge.authorizeGoogle();
      await refreshDoctor();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAuthorizing(false);
    }
  };

  const saveWorker = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (bridge.surface !== 'desktop') return;
    setSavingWorker(true);
    setError('');
    try {
      const input: KeynoteWorkerSettingsInput = workerMode === 'local'
        ? { mode: 'local' }
        : {
            mode: 'remote',
            url: workerUrl,
            ...(workerToken.trim() ? { token: workerToken } : {})
          };
      const settings = await bridge.saveKeynoteWorkerSettings(input);
      setKeynoteSettings(settings);
      setWorkerToken('');
      await refreshDoctor();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingWorker(false);
    }
  };

  const resetConversion = (): void => {
    currentJobId.current = null;
    setSource(null);
    setJob(null);
    setEvents([]);
    setError('');
  };

  const openHistory = (): void => {
    setHistoryOpen(true);
    void refreshHistory();
  };

  const openSetup = (): void => {
    setSetupOpen(true);
    void Promise.all([refreshDoctor(), refreshKeynoteSettings()]);
  };

  let advice = '';
  if (target === 'google' && !googleReady) advice = googleConfigured ? 'Connect your Google account in Setup before native conversion.' : 'Google OAuth is not provisioned in this build.';
  if (target === 'keynote' && !keynoteReady) advice = 'Keynote needs macOS with Keynote installed, locally or through a remote worker.';
  if (target === 'all' && (!googleReady || !keynoteReady)) advice = 'Available targets will run; unavailable targets will be reported instead of silently faked.';

  return <div className="app-frame">
    <header className="app-header">
      <div className="brand"><span className="brand-mark">PB</span><div><strong>Presentation Bridge</strong><small>PPTX converter</small></div></div>
      <div className="header-actions">
        <button className="utility-button" onClick={openHistory}><Icon name="history"/>Recent jobs</button>
        <button className="utility-button" onClick={openSetup}><Icon name="setup"/>Setup</button>
      </div>
    </header>

    <main className="converter-shell">
      <section className="intro">
        <h1>Convert PowerPoint</h1>
        <p>Turn one .pptx file into an editable Google Slides presentation, a native Keynote document, or both.</p>
      </section>

      {error ? <div className="error-banner" role="alert"><Icon name="warning"/><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><Icon name="close"/></button></div> : null}

      <section className="converter-card">
        <div className="field-block">
          <div className="field-heading"><span>1</span><div><h2>PowerPoint file</h2><p>Select the presentation you want to convert.</p></div></div>
          <button className={`file-picker ${source ? 'selected' : ''}`} onClick={() => void selectPresentation()}>
            <span className="file-symbol"><Icon name="file"/></span>
            <span className="file-copy">
              <strong>{source?.name ?? 'Choose a .pptx file'}</strong>
              <small>{source ? `${formatBytes(source.bytes)} · PowerPoint presentation` : 'Click to browse your computer'}</small>
            </span>
            <span className="browse-label">{source ? 'Change' : 'Browse'}</span>
          </button>
          <input ref={fileInput} className="hidden-input" type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" onChange={(event) => selectHostedFile(event.target.files?.[0])}/>
        </div>

        <div className="field-block">
          <div className="field-heading"><span>2</span><div><h2>Convert to</h2><p>Choose one native target or create both.</p></div></div>
          <div className="target-grid">
            {targets.map((option) => {
              const selected = target === option.value;
              const ready = option.value === 'google' ? googleReady : option.value === 'keynote' ? keynoteReady : googleReady && keynoteReady;
              return <button key={option.value} data-target={option.value} className={`target-option ${selected ? 'selected' : ''}`} onClick={() => setTarget(option.value)} aria-pressed={selected}>
                <span className={`platform-icon ${option.icon}`}>
                  {option.icon === 'both' ? <><Icon name="google"/><Icon name="keynote"/></> : <Icon name={option.icon}/>}
                </span>
                <span><strong>{option.title}</strong><small>{option.description}</small></span>
                <StatusDot ready={ready}/>
              </button>;
            })}
          </div>
          {advice ? <div className="advice"><Icon name="warning"/><span>{advice}</span><button onClick={openSetup}>Open Setup</button></div> : null}
        </div>

        {bridge.surface === 'desktop' ? <div className="output-line">
          <div><span>Output folder</span><strong title={outputRoot}>{outputRoot || 'Presentation Bridge runtime folder'}</strong></div>
          <button className="text-button" onClick={() => void chooseOutput()}><Icon name="folder"/>Choose folder</button>
        </div> : null}

        <button className="primary-button" disabled={!canConvert} onClick={() => void startConversion()}><Icon name="convert"/>{isActive ? 'Conversion running' : 'Convert presentation'}</button>
      </section>

      {job ? <section className="progress-card" aria-live="polite">
        <div className="progress-copy"><div><span className={`state-label ${terminalStates.has(job.state) ? job.state : 'active'}`}>{humanState(job.state)}</span><h2>{job.message}</h2></div><strong>{job.percent}%</strong></div>
        <div className="progress-track"><div className="progress-fill" style={{ width: `${job.percent}%` }}/></div>
        <div className="progress-footer">
          <span>{events.at(-1)?.message ?? 'Preparing conversion…'}</span>
          {isActive ? <button className="danger-button" onClick={() => void cancelConversion()}>Cancel</button> : null}
        </div>
        {events.length ? <details className="event-log"><summary>Show process log</summary><div>{events.map((event, index) => <p key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString()}</time><span>{humanState(event.stage)}</span>{event.message}</p>)}</div></details> : null}
      </section> : null}

      {report ? <section className="results-card">
        <div className="results-heading"><span className={`result-mark ${report.status === 'failed' ? 'bad' : ''}`}><Icon name={report.status === 'failed' ? 'warning' : 'check'}/></span><div><h2>Conversion finished</h2><p>{report.warnings.length ? `${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'} recorded in the compatibility report.` : 'The requested target checks finished without warnings.'}</p></div></div>
        <div className="results-grid"><ResultCard name="google" result={report.targets.google}/><ResultCard name="keynote" result={report.targets.keynote}/></div>
        <div className="results-footer">
          {htmlReportPath ? <button className="secondary-button" onClick={() => void bridge.openReport({ jobId: report.jobId, htmlReportPath })}><Icon name="external"/>View compatibility report</button> : null}
          <button className="text-button" onClick={resetConversion}>Convert another file</button>
        </div>
      </section> : null}
    </main>

    <footer className="app-footer">
      <span>{bridge.surface === 'desktop' ? 'Desktop app' : 'Browser app'}</span>
      <span><StatusDot ready={googleReady}/>Google</span>
      <span><StatusDot ready={keynoteReady}/>Keynote</span>
      <button onClick={() => void refreshDoctor()} disabled={loadingDoctor}><Icon name="refresh"/>{loadingDoctor ? 'Checking…' : 'Refresh status'}</button>
    </footer>

    <Dialog open={historyOpen} title="Recent jobs" onClose={() => setHistoryOpen(false)} wide>
      <div className="dialog-toolbar"><span>{history.length} saved conversion{history.length === 1 ? '' : 's'}</span><button className="text-button" onClick={() => void refreshHistory()}><Icon name="refresh"/>Refresh</button></div>
      <div className="history-list">
        {history.length === 0 ? <div className="empty-state"><Icon name="history"/><strong>No conversions yet</strong><span>Completed jobs will appear here.</span></div> : null}
        {history.map((item) => <article className="history-row" key={item.jobId}>
          <span className="file-symbol small"><Icon name="file"/></span>
          <div><strong>{item.sourceFilename ?? item.jobId}</strong><small>{new Date(item.finishedAt ?? item.updatedAt).toLocaleString()}</small></div>
          <span className={`state-label ${item.state}`}>{humanState(item.state)}</span>
          {item.htmlReportPath ? <button className="icon-button" onClick={() => void bridge.openReport(item)} aria-label="Open compatibility report"><Icon name="external"/></button> : <span/>}
        </article>)}
      </div>
    </Dialog>

    <Dialog open={setupOpen} title="Setup" onClose={() => setSetupOpen(false)} wide>
      <div className="setup-stack">
        <section className="setup-section">
          <div className="setup-title"><span className="platform-icon google"><Icon name="google"/></span><div><h3>Google Slides</h3><p>Connect the Google account that will own imported presentations.</p></div></div>
          <div className="setup-status"><div><StatusDot ready={googleReady}/><strong>{googleReady ? 'Connected and ready' : googleConfigured ? 'Authorization required' : 'OAuth client not provisioned'}</strong></div>{googleConfigured && !googleReady ? <button className="secondary-button" disabled={authorizing} onClick={() => void connectGoogle()}>{authorizing ? 'Waiting for browser…' : 'Connect Google'}</button> : null}</div>
        </section>

        <section className="setup-section">
          <div className="setup-title"><span className="platform-icon keynote"><Icon name="keynote"/></span><div><h3>Keynote</h3><p>Use this Mac directly or connect a remote Mac that has Keynote installed.</p></div></div>
          {bridge.surface === 'desktop' ? <form className="worker-form" onSubmit={(event) => void saveWorker(event)}>
            <div className="mode-switch"><button type="button" className={workerMode === 'local' ? 'selected' : ''} onClick={() => setWorkerMode('local')}>This Mac</button><button type="button" className={workerMode === 'remote' ? 'selected' : ''} onClick={() => setWorkerMode('remote')}>Remote Mac</button></div>
            {workerMode === 'remote' ? <div className="worker-fields"><label><span>Worker URL</span><input type="url" value={workerUrl} onChange={(event) => setWorkerUrl(event.target.value)} placeholder="https://mac-worker.example.com" required/></label><label><span>Access token</span><input type="password" value={workerToken} onChange={(event) => setWorkerToken(event.target.value)} placeholder={keynoteSettings?.tokenConfigured ? 'Leave blank to keep saved token' : 'Required'} required={!keynoteSettings?.tokenConfigured}/></label></div> : <p className="setup-note">Local conversion becomes available automatically on macOS when Keynote automation is permitted.</p>}
            <div className="setup-actions"><span><StatusDot ready={keynoteReady}/>{keynoteReady ? 'Keynote worker ready' : String(doctor?.keynote.reason ?? 'Worker not ready')}</span><button className="secondary-button" type="submit" disabled={savingWorker}>{savingWorker ? 'Saving…' : 'Save Keynote setup'}</button></div>
          </form> : <p className="setup-note">Hosted mode uses the Keynote worker configured on the server.</p>}
        </section>

        <section className="diagnostics-line"><span>Runtime</span><strong>{doctor ? `${doctor.node} · ${doctor.platform}/${doctor.arch}` : 'Checking…'}</strong><span>Isolation</span><strong>{doctor?.isolation.clean ? 'Clean' : doctor ? 'Review required' : 'Checking…'}</strong></section>
      </div>
    </Dialog>
  </div>;
}
