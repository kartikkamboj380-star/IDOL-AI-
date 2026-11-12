import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity, ArrowDown, ArrowRight, ArrowUp, Bot, Check, ChevronDown, CircleHelp, Code2,
  Command, Copy, Download, FileCode2, FilePlus2, Files, FolderKanban, Github, ImagePlus, LockKeyhole,
  LogOut, Menu, MessageCircle, MessagesSquare, Moon, MoreHorizontal, PanelLeftClose,
  PanelLeftOpen, Plus, Search, Settings2, Shield, Sparkles, Sun, Trash2, WandSparkles, WifiOff, X,
} from 'lucide-react';
import {
  api, streamChat, ApiError, type Agent, type ChatMessage, type Conversation,
  type EngineInfo, type ModelInfo, type Project, type ProviderInfo, type User,
} from './api';

type ViewId = 'chat' | 'projects' | 'agents' | 'engines' | 'models' | 'images' | 'files' | 'github' | 'services' | 'settings' | 'admin';
type Theme = 'dark' | 'light';
interface BeforeInstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>; }

const primaryNav: { id: ViewId; label: string; icon: typeof MessageCircle }[] = [
  { id: 'chat', label: 'New chat', icon: MessageCircle },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'agents', label: 'Agent studio', icon: Bot },
  { id: 'engines', label: 'Engine center', icon: Activity },
  { id: 'models', label: 'Model library', icon: Sparkles },
];
const workspaceNav: { id: ViewId; label: string; icon: typeof MessageCircle }[] = [
  { id: 'images', label: 'Image studio', icon: ImagePlus },
  { id: 'files', label: 'File workspace', icon: Files },
  { id: 'github', label: 'GitHub connect', icon: Github },
  { id: 'services', label: 'Connected services', icon: Command },
];

function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? 'brand-mark-small' : ''}`} aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="M8 8h24L17 20l15 12H8V8Z" stroke="currentColor" strokeWidth="2.3" strokeLinejoin="round"/><path d="M8 20h11" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round"/><circle cx="31" cy="8" r="2" fill="currentColor"/></svg></span>;
}

function AuthScreen({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const resetToken = useState(() => new URLSearchParams(window.location.search).get('reset_token') ?? '')[0];
  const verifyToken = useState(() => new URLSearchParams(window.location.search).get('verify_token') ?? '')[0];
  useEffect(() => {
    if (!verifyToken) return;
    api('/auth/email-verification/confirm', { method: 'POST', body: JSON.stringify({ token: verifyToken }) }).then(() => setMessage('Email verified. You can sign in now.')).catch(err => setError(err.message));
    window.history.replaceState({}, '', window.location.pathname);
  }, [verifyToken]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setMessage(''); setBusy(true);
    try {
      const path = mode === 'register' ? '/auth/register' : '/auth/login';
      const body = mode === 'register' ? { email, password, name } : { email, password };
      const result = await api<{ user: User; verification_required?: boolean }>(path, { method: 'POST', body: JSON.stringify(body) });
      if (result.verification_required) { setMode('login'); setMessage('Check your inbox for a verification token before signing in.'); }
      else onSignedIn(result.user);
    } catch (err) { setError(err instanceof Error ? err.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  }
  async function recover(event: FormEvent) {
    event.preventDefault(); setError(''); setMessage(''); setBusy(true);
    try {
      if (resetToken) {
        await api('/auth/password-reset/confirm', { method: 'POST', body: JSON.stringify({ token: resetToken, password: recoveryPassword }) });
        window.history.replaceState({}, '', window.location.pathname);
        setMessage('Password updated. Sign in with your new password.');
        setRecovering(false);
      } else {
        const result = await api<{ message: string }>('/auth/password-reset/request', { method: 'POST', body: JSON.stringify({ email }) });
        setMessage(result.message); setRecovering(false);
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not complete password recovery.'); }
    finally { setBusy(false); }
  }
  async function googleLogin() {
    setError(''); setBusy(true);
    try { const result = await api<{ authorization_url: string }>('/auth/google/start'); window.location.assign(result.authorization_url); }
    catch (err) { setError(err instanceof Error ? err.message : 'Google login is not configured.'); setBusy(false); }
  }
  return <main className="auth-page">
    <div className="auth-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="art-core"><BrandMark/><span>INTELLIGENCE<br/>IN MOTION</span></div><div className="art-note note-a">Context aware</div><div className="art-note note-b">Built for focus</div></div>
    <section className="auth-panel">
      <div className="auth-brand"><BrandMark/><span>KAVRON<span className="brand-ai"> AI</span></span></div>
      <div className="auth-copy"><p className="eyebrow">INTELLIGENCE. TOOLS. AGENTS.</p><h1>Your workspace<br/>for what’s next.</h1><p className="muted">A calm, configurable home for your ideas, projects, and AI tools.</p></div>
      {recovering ? <form className="auth-form" onSubmit={recover}><h2>{resetToken ? 'Choose a new password' : 'Reset your password'}</h2>{!resetToken && <label>Email address<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"/></label>}{resetToken && <label>New password<input type="password" minLength={10} required value={recoveryPassword} onChange={e => setRecoveryPassword(e.target.value)} placeholder="At least 10 characters"/></label>}{error && <div className="inline-error" role="alert">{error}</div>}{message && <p role="status">{message}</p>}<button className="button button-primary auth-submit" disabled={busy}>{busy ? 'Please wait…' : resetToken ? 'Update password' : 'Send reset instructions'}<ArrowRight size={16}/></button><button type="button" className="text-link" onClick={() => { setRecovering(false); setError(''); }}>Back to sign in</button></form> : <form className="auth-form" onSubmit={submit}>
        <div className="auth-tabs"><button type="button" className={mode === 'register' ? 'selected' : ''} onClick={() => { setMode('register'); setError(''); setMessage(''); }}>Create account</button><button type="button" className={mode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setError(''); setMessage(''); }}>Sign in</button></div>
        {mode === 'register' && <label>Your name<input autoComplete="name" required minLength={1} maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="Kartik Kamboj"/></label>}
        <label>Email address<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"/></label>
        <label>Password<input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={10} required value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 10 characters"/></label>
        {mode === 'login' && <button type="button" className="text-link" onClick={() => { setRecovering(true); setError(''); }}>Forgot password?</button>}
        {error && <div className="inline-error" role="alert">{error}</div>}{message && <p role="status">{message}</p>}
        <button className="button button-primary auth-submit" disabled={busy}>{busy ? <span className="spinner"/> : mode === 'register' ? 'Create your workspace' : 'Continue'}<ArrowRight size={16}/></button>
        <button type="button" className="button button-secondary auth-submit" onClick={() => void googleLogin()} disabled={busy}><span className="google-g">G</span>Continue with Google</button>
        <p className="auth-privacy"><LockKeyhole size={13}/> Your workspace is private to your account.</p>
      </form>}
      <footer className="auth-footer">KAVRON AI <span>·</span> Built by Kartik Kamboj</footer>
    </section>
  </main>;
}

function IconButton({ label, onClick, children, className = '', disabled = false }: { label: string; onClick: () => void; children: ReactNode; className?: string; disabled?: boolean }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [view, setView] = useState<ViewId>('chat');
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('kavron-theme') as Theme) || 'dark');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationHasMore, setConversationHasMore] = useState(false);
  const [conversationPage, setConversationPage] = useState(1);
  const [conversationLoadingMore, setConversationLoadingMore] = useState(false);
  const [conversationSearch, setConversationSearch] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [online, setOnline] = useState(() => navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  const refreshInventory = useCallback(async () => {
    try {
      const [modelData, engineData] = await Promise.all([
        api<{ models: ModelInfo[]; providers: ProviderInfo[] }>('/models'),
        api<{ engines: EngineInfo[] }>('/engines'),
      ]);
      setModels(modelData.models); setProviders(modelData.providers); setEngines(engineData.engines);
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Could not load engine status.'); }
  }, []);

  const refreshConversations = useCallback(async (search = '', page = 1, append = false) => {
    if (append) setConversationLoadingMore(true);
    try {
      const result = await api<{ items: Conversation[]; has_more: boolean }>(`/conversations?search=${encodeURIComponent(search)}&page=${page}&page_size=50`);
      setConversations(current => append ? [...current, ...result.items] : result.items);
      setConversationHasMore(result.has_more); setConversationPage(page);
    } catch (err) { if (!(err instanceof ApiError && err.status === 401)) setNotice(err instanceof Error ? err.message : 'Could not load chat history.'); }
    finally { if (append) setConversationLoadingMore(false); }
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('kavron-theme', theme); }, [theme]);
  useEffect(() => {
    api<{ user: User }>('/auth/me').then(result => setUser(result.user)).catch(() => setUser(null)).finally(() => setAuthChecked(true));
  }, []);
  useEffect(() => {
    if (!user) return;
    api<{ theme?: string }>('/auth/preferences').then(result => { if (result.theme === 'dark' || result.theme === 'light') setTheme(result.theme); }).catch(() => undefined);
  }, [user?.id]);
  useEffect(() => { if (user) { void refreshInventory(); void refreshConversations(); } }, [user, refreshInventory, refreshConversations]);
  useEffect(() => {
    const onOnline = () => { setOnline(true); if (user) { void refreshInventory(); void refreshConversations(conversationSearch); } };
    const onOffline = () => setOnline(false);
    const onInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as BeforeInstallPromptEvent); };
    const onInstalled = () => setInstallPrompt(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setConversationId(null); setProjectId(null); setView('chat'); }
      if (event.key === 'Escape') setMobileMenu(false);
    };
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
    window.addEventListener('beforeinstallprompt', onInstall); window.addEventListener('appinstalled', onInstalled);
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); window.removeEventListener('beforeinstallprompt', onInstall); window.removeEventListener('appinstalled', onInstalled); window.removeEventListener('keydown', onKeyDown); };
  }, [user, refreshInventory, refreshConversations, conversationSearch]);
  useEffect(() => {
    const navigate = (event: Event) => {
      const destination = (event as CustomEvent<ViewId>).detail;
      if (destination) setView(destination);
    };
    window.addEventListener('kavron:navigate', navigate);
    return () => window.removeEventListener('kavron:navigate', navigate);
  }, []);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 5500); return () => window.clearTimeout(timer); }, [notice]);

  function newChat() { setConversationId(null); setProjectId(null); setView('chat'); setMobileMenu(false); }
  function openConversation(id: string, selectedProject: string | null) { setConversationId(id); setProjectId(selectedProject); setView('chat'); setMobileMenu(false); }
  function handleSignedIn(nextUser: User) { setUser(nextUser); setView('chat'); }
  async function logout() { try { await api('/auth/logout', { method: 'POST' }); } catch { /* Clear client state even if the session expired. */ } setUser(null); setConversationId(null); setConversations([]); }
  async function saveTheme(next: Theme) { setTheme(next); try { await api('/auth/preferences', { method: 'PATCH', body: JSON.stringify({ theme: next }) }); } catch (err) { setNotice(err instanceof Error ? `Theme changed locally; server preference was not saved: ${err.message}` : 'Theme changed locally; server preference was not saved.'); } }
  async function installApp() { if (!installPrompt) return; await installPrompt.prompt(); await installPrompt.userChoice; setInstallPrompt(null); }

  if (!authChecked) return <div className="boot-screen"><BrandMark/><span>KAVRON</span><div className="spinner"/></div>;
  if (!user) return <AuthScreen onSignedIn={handleSignedIn}/>;

  const titleMap: Record<ViewId, string> = { chat: 'Workspace', projects: 'Projects', agents: 'Agent studio', engines: 'Engine center', models: 'Model library', images: 'Image studio', files: 'File workspace', github: 'GitHub connect', services: 'Connected services', settings: 'Settings', admin: 'Admin console' };
  const mainContent = () => {
    switch (view) {
      case 'chat': return <ChatView user={user} models={models} conversations={conversations} conversationId={conversationId} projectId={projectId} setConversationId={setConversationId} onConversationUpdate={() => void refreshConversations(conversationSearch)} onNotice={setNotice}/>;
      case 'projects': return <ProjectsView models={models} providers={providers} onOpenConversation={(id, project) => { setProjectId(project); setConversationId(id); setView('chat'); }} onNotice={setNotice}/>;
      case 'agents': return <AgentsView models={models} providers={providers} onNotice={setNotice}/>;
      case 'engines': return <EngineView engines={engines} providers={providers} onRefresh={refreshInventory} onNotice={setNotice}/>;
      case 'models': return <ModelsView models={models} providers={providers} onRefresh={refreshInventory}/>;
      case 'images': return <ImageStudioView engines={engines} onNotice={setNotice}/>;
      case 'files': return <FilesView onNotice={setNotice}/>;
      case 'github': return <GitHubView onNotice={setNotice}/>;
      case 'services': return <ServicesView providers={providers} onRefresh={refreshInventory} onNotice={setNotice}/>;
      case 'settings': return <SettingsView user={user} theme={theme} onTheme={saveTheme} onLogout={logout} onNotice={setNotice} onProfileUpdate={setUser}/>;
      case 'admin': return <AdminView user={user}/>;
      default: return null;
    }
  };

  return <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
    <aside className={`sidebar ${mobileMenu ? 'mobile-open' : ''}`}>
      <div className="sidebar-brand"><BrandMark small/><span>KAVRON<span className="brand-ai"> AI</span></span><span className="brand-beta">WORKSPACE</span><IconButton label="Close navigation" className="mobile-close" onClick={() => setMobileMenu(false)}><X size={18}/></IconButton></div>
      <div className="sidebar-actions"><button className="new-chat-button" onClick={newChat}><Plus size={17}/><span>New conversation</span><kbd>⌘ K</kbd></button></div>
      <nav className="sidebar-nav" aria-label="Main navigation">
        <div className="nav-section-label">WORKSPACE</div>
        {primaryNav.map(item => <NavButton key={item.id} item={item} active={view === item.id} onClick={() => { setView(item.id); if (item.id === 'chat') { setConversationId(null); setProjectId(null); } setMobileMenu(false); }}/>) }
        <div className="nav-section-label nav-spaced">TOOLS</div>
        {workspaceNav.map(item => <NavButton key={item.id} item={item} active={view === item.id} onClick={() => { setView(item.id); setMobileMenu(false); }}/>) }
        <div className="history-heading"><span>RECENT</span><button aria-label="Refresh conversations" onClick={() => void refreshConversations(conversationSearch)}><MoreHorizontal size={16}/></button></div>
        <div className="history-search"><Search size={14}/><input aria-label="Search conversations" value={conversationSearch} onChange={event => { setConversationSearch(event.target.value); void refreshConversations(event.target.value); }} placeholder="Search chats"/></div>
        <div className="history-list">{conversations.map(conversation => <button key={conversation.id} className={`history-item ${conversationId === conversation.id ? 'active' : ''}`} onClick={() => openConversation(conversation.id, conversation.project_id)} title={conversation.title}><MessagesSquare size={14}/><span>{conversation.title}</span></button>)}{conversations.length === 0 && <p className="sidebar-empty">Your conversations will appear here.</p>}{conversationHasMore && <button className="history-load-more" disabled={conversationLoadingMore} onClick={() => void refreshConversations(conversationSearch, conversationPage + 1, true)}>{conversationLoadingMore ? 'Loading…' : 'Load more conversations'}</button>}</div>
      </nav>
      <div className="sidebar-bottom">
        <NavButton item={{ id: 'settings', label: 'Settings', icon: Settings2 }} active={view === 'settings'} onClick={() => { setView('settings'); setMobileMenu(false); }}/>
        {user.role === 'admin' && <NavButton item={{ id: 'admin', label: 'Admin console', icon: Shield }} active={view === 'admin'} onClick={() => { setView('admin'); setMobileMenu(false); }}/>}
        <button className="account-button" onClick={() => setView('settings')}><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><span className="account-name"><strong>{user.name}</strong><small>{user.role === 'admin' ? 'Administrator' : 'Personal workspace'}</small></span><ChevronDown size={15}/></button>
      </div>
    </aside>
    {mobileMenu && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileMenu(false)}/>}
    <main className="main-column">
      <header className="topbar"><div className="topbar-left"><IconButton label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'} className="desktop-sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>{sidebarOpen ? <PanelLeftClose size={18}/> : <PanelLeftOpen size={18}/>}</IconButton><IconButton label="Open navigation" className="mobile-menu-button" onClick={() => setMobileMenu(true)}><Menu size={20}/></IconButton><div className="breadcrumbs"><span>KAVRON</span><span className="crumb-slash">/</span><strong>{titleMap[view]}</strong></div></div><div className="topbar-right"><div className={`connection-pill ${models.length ? 'is-ready' : ''}`}><span className="status-dot"/>{models.length ? `${models.length} model${models.length === 1 ? '' : 's'} ready` : 'No model connected'}</div>{installPrompt && <button className="install-app-button" onClick={() => void installApp()}><Download size={15}/><span>Install</span></button>}<IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={17}/> : <Moon size={17}/>}</IconButton><button className="avatar top-avatar" onClick={() => setView('settings')} title={user.email}>{user.name.slice(0, 1).toUpperCase()}</button></div></header>{!online && <div className="offline-banner" role="status"><WifiOff size={16}/><span>Offline — your recent workspace shell is available; private API data is not cached.</span><button onClick={() => { if (navigator.onLine) { setOnline(true); void refreshInventory(); void refreshConversations(); } }}>Retry</button></div>}
      <div className="content-scroll" key={view}>{mainContent()}</div>
      <footer className="app-footer"><span><BrandMark small/>KAVRON AI</span><span>Built by Kartik Kamboj</span></footer>
    </main>
    {notice && <div className="toast" role="status"><CircleHelp size={16}/><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={15}/></button></div>}
    <nav className="mobile-bottom-nav" aria-label="Quick navigation">{[primaryNav[0], primaryNav[1], primaryNav[2], workspaceNav[0]].map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => { setView(item.id); setMobileMenu(false); }}><item.icon size={19}/><span>{item.id === 'chat' ? 'Chat' : item.id === 'projects' ? 'Projects' : item.id === 'agents' ? 'Agents' : 'Images'}</span></button>)}</nav>
  </div>;
}

function NavButton({ item, active, onClick }: { item: { id: string; label: string; icon: typeof MessageCircle }; active: boolean; onClick: () => void }) {
  const Icon = item.icon;
  return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}><Icon size={17}/><span>{item.label}</span>{item.id === 'agents' && <span className="nav-count">AI</span>}</button>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{action && <div className="heading-action">{action}</div>}</div>;
}

function StatusBadge({ ready, children }: { ready: boolean; children: ReactNode }) { return <span className={`status-badge ${ready ? 'ready' : ''}`}><span className="status-dot"/>{children}</span>; }

function ChatView({ user, models, conversations, conversationId, projectId, setConversationId, onConversationUpdate, onNotice }: {
  user: User; models: ModelInfo[]; conversations: Conversation[]; conversationId: string | null; projectId: string | null; setConversationId: (id: string | null) => void; onConversationUpdate: () => void; onNotice: (message: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedProject, setSelectedProject] = useState(projectId ?? '');
  const [projects, setProjects] = useState<Project[]>([]);
  const [attached, setAttached] = useState<{ id: string; name: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [editingId, setEditingId] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setSelectedProject(projectId ?? ''); }, [projectId]);
  useEffect(() => {
    api<{ items: Project[] }>('/projects').then(data => setProjects(data.items)).catch(() => setProjects([]));
  }, []);
  useEffect(() => {
    setMessages([]); setError(''); setAttached([]);
    if (!conversationId) return;
    api<{ items: ChatMessage[] }>(`/conversations/${conversationId}/messages`).then(data => setMessages(data.items)).catch(err => setError(err.message));
  }, [conversationId]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, sending]);

  async function attachFile(file?: File) {
    if (!file) return;
    const form = new FormData(); form.append('file', file);
    try {
      const result = await api<{ id: string; name: string }>('/files', { method: 'POST', body: form });
      setAttached(current => [...current, { id: result.id, name: result.name }]);
      onNotice(`${result.name} is ready to use as conversation context.`);
    } catch (err) { onNotice(err instanceof Error ? err.message : 'Upload failed.'); }
    if (fileRef.current) fileRef.current.value = '';
  }

  async function sendMessage(text = draft) {
    const content = text.trim();
    if (!content || sending) return;
    if (!models.length) { setError('Connect Ollama or an OpenAI-compatible model in Engine Center before chatting.'); return; }
    setDraft(''); setError(''); setSending(true);
    const tempUser = `local-user-${Date.now()}`;
    const tempAssistant = `local-assistant-${Date.now()}`;
    setMessages(current => [...current, { id: tempUser, role: 'user', content, created_at: new Date().toISOString() }, { id: tempAssistant, role: 'assistant', content: '', status: 'streaming' }]);
    setStreamingId(tempAssistant);
    const controller = new AbortController(); abortRef.current = controller;
    try {
      await streamChat({ message: content, conversation_id: conversationId ?? undefined, project_id: selectedProject || undefined, provider: selectedProvider || undefined, model: selectedModel || undefined, file_ids: attached.map(file => file.id) }, controller.signal, event => {
        if (event.type === 'meta') {
          if (!conversationId) setConversationId(event.conversation_id);
          setSelectedModel(event.model); setSelectedProvider(event.provider);
        } else if (event.type === 'delta') {
          setMessages(current => current.map(message => message.id === tempAssistant ? { ...message, content: message.content + event.content } : message));
        } else if (event.type === 'error') {
          setMessages(current => current.flatMap(message => message.id !== tempAssistant ? [message] : message.content ? [{ ...message, status: 'error' }] : []));
          setError(event.message);
        } else if (event.type === 'done') {
          setMessages(current => current.map(message => message.id === tempAssistant ? { ...message, status: 'complete' } : message));
          setAttached([]);
        }
      });
      onConversationUpdate();
    } catch (err) {
      if (!controller.signal.aborted) {
        setMessages(current => current.filter(message => message.id !== tempAssistant));
        setError(err instanceof Error ? err.message : 'Generation failed.');
      }
    } finally { setSending(false); setStreamingId(null); abortRef.current = null; }
  }

  async function copyMessage(id: string, content: string) {
    try { await navigator.clipboard.writeText(content); setCopied(id); window.setTimeout(() => setCopied(''), 1600); }
    catch { onNotice('Clipboard access is unavailable in this browser.'); }
  }
  function reuseMessage(message: ChatMessage) { setDraft(message.content); setEditingId(message.id); document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus(); }
  function stop() { abortRef.current?.abort(); if (streamingId) setMessages(current => current.map(message => message.id === streamingId ? { ...message, status: 'stopped' } : message)); setSending(false); setStreamingId(null); }
  const currentConversation = conversations.find(item => item.id === conversationId);
  const selectedModelInfo = models.find(model => model.id === selectedModel);

  return <div className={`chat-view ${messages.length ? 'has-messages' : ''}`}>
    {messages.length === 0 ? <div className="chat-welcome">
      <div className="welcome-mark"><BrandMark/></div>
      <p className="eyebrow">YOUR THINKING SPACE</p>
      <h1>What are we<br/><span>working on?</span></h1>
      <p className="welcome-subtitle">Bring a question, a document, or a project. KAVRON will work with the tools you connect.</p>
      {!models.length && <div className="provider-warning"><div className="warning-icon"><Activity size={17}/></div><div><strong>No model provider connected</strong><p>Configure Ollama or an OpenAI-compatible endpoint to get real responses.</p></div><button onClick={() => window.dispatchEvent(new CustomEvent('kavron:navigate', { detail: 'engines' }))}>Set up <ArrowRight size={14}/></button></div>}
      <div className="suggestion-grid">{[
        { icon: FileCode2, title: 'Understand a codebase', text: 'Explain how a system is structured' },
        { icon: WandSparkles, title: 'Explore an idea', text: 'Think through a new direction' },
        { icon: Files, title: 'Work with a document', text: 'Summarize or extract key details' },
      ].map((item, index) => <button key={item.title} className="suggestion-card" onClick={() => setDraft(['Help me understand the structure of this codebase.', 'Help me explore this idea and identify useful next steps.', 'Summarize the attached document and list its key points.'][index])}><item.icon size={16}/><strong>{item.title}</strong><span>{item.text}</span><ArrowRight className="suggestion-arrow" size={14}/></button>)}</div>
    </div> : <div className="message-list">
      <div className="conversation-title-row"><span className="eyebrow">{currentConversation?.title || 'CONVERSATION'}</span><div className="context-pills">{selectedModelInfo && <span className="context-pill"><Sparkles size={12}/>{selectedModelInfo.id}</span>}{selectedProject && <span className="context-pill"><FolderKanban size={12}/>{projects.find(p => p.id === selectedProject)?.name || 'Project'}</span>}</div></div>
      {messages.map(message => <article key={message.id} className={`message-row ${message.role}`}>
        <div className={`message-avatar ${message.role === 'assistant' ? 'assistant-avatar' : ''}`}>{message.role === 'assistant' ? <BrandMark small/> : user.name.slice(0, 1).toUpperCase()}</div>
        <div className="message-main"><div className="message-meta"><strong>{message.role === 'assistant' ? 'KAVRON' : 'You'}</strong>{message.model && message.role === 'assistant' && <span>{message.model}</span>}{message.status === 'streaming' && <span className="stream-indicator"><span/>Generating</span>}</div>
          {message.role === 'assistant' && !message.content && message.status === 'streaming' ? <div className="typing-dots"><i/><i/><i/></div> : <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>}
          <div className="message-actions">{message.role === 'assistant' && message.content && <button onClick={() => void copyMessage(message.id, message.content)}><Copy size={13}/>{copied === message.id ? 'Copied' : 'Copy'}</button>}{message.role === 'user' && <button onClick={() => reuseMessage(message)}><FileCode2 size={13}/>{editingId === message.id ? 'Editing' : 'Reuse'}</button>}{message.role === 'assistant' && message.status === 'complete' && <button onClick={() => { const previous = [...messages].reverse().find(item => item.role === 'user'); if (previous) void sendMessage(previous.content); }}><ArrowDown size={13}/>Regenerate</button>}</div>
        </div>
      </article>)}
      <div ref={bottomRef}/>
    </div>}
    {error && <div className="chat-error" role="alert"><CircleHelp size={17}/><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
    <div className="composer-wrap">
      {attached.length > 0 && <div className="attachment-strip">{attached.map(file => <span className="attachment-chip" key={file.id}><Files size={13}/>{file.name}<button aria-label={`Remove ${file.name}`} onClick={() => setAttached(current => current.filter(item => item.id !== file.id))}><X size={12}/></button></span>)}</div>}
      <div className="composer">
        <textarea className="composer-input" aria-label="Message KAVRON" placeholder={models.length ? 'Ask anything. Use # to add context.' : 'Connect a model provider to start a conversation…'} rows={1} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }} onInput={e => { e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 180)}px`; }} />
        <div className="composer-toolbar"><div className="composer-tools"><input ref={fileRef} type="file" className="visually-hidden" accept=".txt,.md,.markdown,.json,.csv,.py,.ts,.tsx,.js,.jsx,.html,.css,.yaml,.yml,.toml,.sql,.go,.rs,.java,.sh,.xml,.ini,.log,.pdf,.docx" onChange={e => void attachFile(e.target.files?.[0])}/><button className="tool-button" title="Attach a document" onClick={() => fileRef.current?.click()}><Plus size={16}/><span>Attach</span></button>{projects.length > 0 && <label className="select-wrap project-select"><FolderKanban size={13}/><select aria-label="Choose project" value={selectedProject} onChange={e => setSelectedProject(e.target.value)}><option value="">No project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown size={12}/></label>}</div>
          <div className="composer-right"><label className="model-select"><select aria-label="Select model" disabled={!models.length} value={selectedModel} onChange={e => { const model = models.find(item => item.id === e.target.value); setSelectedModel(e.target.value); if (model) setSelectedProvider(model.provider); }}><option value="">{models.length ? 'Select model' : 'No model'}</option>{models.map(model => <option key={`${model.provider}:${model.id}`} value={model.id}>{model.id}</option>)}</select><ChevronDown size={13}/></label>{sending ? <button className="send-button stop-button" aria-label="Stop generation" onClick={stop}><span className="stop-square"/></button> : <button className="send-button" aria-label="Send message" disabled={!draft.trim() || !models.length} onClick={() => void sendMessage()}><ArrowUp size={19}/></button>}</div>
        </div>
      </div>
      <p className="composer-note">KAVRON uses only configured providers. Check important information independently.</p>
    </div>
  </div>;
}

function ProjectsView({ models, providers, onOpenConversation, onNotice }: { models: ModelInfo[]; providers: ProviderInfo[]; onOpenConversation: (id: string, project: string) => void; onNotice: (message: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectPage, setProjectPage] = useState(1); const [projectHasMore, setProjectHasMore] = useState(false); const [projectsLoadingMore, setProjectsLoadingMore] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async (page = 1, append = false) => { if (append) setProjectsLoadingMore(true); try { const data = await api<{ items: Project[]; has_more: boolean }>(`/projects?page=${page}&page_size=50`); setProjects(current => append ? [...current, ...data.items] : data.items); setProjectPage(page); setProjectHasMore(data.has_more); } catch (err) { setError(err instanceof Error ? err.message : 'Could not load projects.'); } finally { if (append) setProjectsLoadingMore(false); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function create(event: FormEvent) { event.preventDefault(); if (!name.trim()) return; setBusy(true); setError(''); try { await api('/projects', { method: 'POST', body: JSON.stringify({ name, description, instructions }) }); setName(''); setDescription(''); setInstructions(''); await refresh(); onNotice('Project created.'); } catch (err) { setError(err instanceof Error ? err.message : 'Could not create project.'); } finally { setBusy(false); } }
  async function remove(project: Project) { if (!window.confirm(`Delete “${project.name}”? Conversations will be unassigned, not deleted.`)) return; try { await api(`/projects/${project.id}`, { method: 'DELETE' }); await refresh(); onNotice('Project deleted.'); } catch (err) { onNotice(err instanceof Error ? err.message : 'Could not delete project.'); } }
  if (selectedProject) return <ProjectWorkspaceView project={selectedProject} models={models} providers={providers} onBack={() => setSelectedProject(null)} onOpenConversation={onOpenConversation} onNotice={onNotice}/>;
  return <section className="page-view"><PageHeading eyebrow="ORGANIZE YOUR WORK" title="Projects" description="Keep conversations and instructions together around a shared goal."/><div className="page-grid projects-layout"><div className="project-list-area"><div className="section-title-row"><h2>Your projects</h2><span>{projects.length} loaded</span></div>{error && <div className="inline-error">{error}</div>}{projects.length ? <div className="project-grid">{projects.map(project => <article className="project-card" key={project.id}><div className="project-card-top"><span className="project-icon"><FolderKanban size={18}/></span><button className="quiet-icon" onClick={() => void remove(project)} aria-label={`Delete ${project.name}`}><Trash2 size={15}/></button></div><h3>{project.name}</h3><p>{project.description || 'A focused space for your work and context.'}</p><div className="project-card-meta"><span>{project.conversation_count ?? 0} conversations</span><span>Updated {new Date(project.updated_at).toLocaleDateString()}</span></div><button className="text-link" onClick={() => setSelectedProject(project)}>Open project <ArrowRight size={14}/></button></article>)}</div> : <div className="empty-card"><div className="empty-icon"><FolderKanban size={20}/></div><h3>No projects yet</h3><p>Start a project to keep its conversations and instructions in one place.</p></div>}{projectHasMore && <button className="button button-secondary" disabled={projectsLoadingMore} onClick={() => void refresh(projectPage + 1, true)}>{projectsLoadingMore ? 'Loading…' : 'Load more projects'}</button>}</div>
    <form className="surface-card project-create" onSubmit={create}><div className="card-heading-icon"><Plus size={17}/></div><h2>Start a project</h2><p>Give KAVRON a little context for the work ahead.</p><label>Project name<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="Product launch"/></label><label>Description<textarea maxLength={1000} rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="What is this project about?"/></label><label>Project instructions <span className="optional">optional</span><textarea maxLength={6000} rows={4} value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="Goals, preferences, or relevant background"/></label>{error && <p className="inline-error">{error}</p>}<button className="button button-primary" disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create project'}<ArrowRight size={15}/></button></form></div></section>;
}

type ProjectMemoryItem = { id: string; source_type: string; source_id: string; content: string; created_at: string; updated_at: string };
type ProjectActivityItem = { action: string; resource_type: string; resource_id: string; detail: Record<string, unknown>; created_at: string };
type ProjectWorkspaceData = {
  project: Project;
  conversations: Conversation[];
  files: Array<{ id: string; name: string; content_type: string; size_bytes: number; attached_at: string }>;
  agents: Array<{ id: string; name: string; description: string; enabled_engines: string[] }>;
  repositories: Array<{ repo_id: string; full_name: string; assigned_at: string }>;
};

function ProjectWorkspaceView({ project, models, providers, onBack, onOpenConversation, onNotice }: { project: Project; models: ModelInfo[]; providers: ProviderInfo[]; onBack: () => void; onOpenConversation: (id: string, project: string) => void; onNotice: (message: string) => void }) {
  const [workspace, setWorkspace] = useState<ProjectWorkspaceData | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [availableFiles, setAvailableFiles] = useState<Array<{ id: string; name: string }>>([]);
  const [memories, setMemories] = useState<ProjectMemoryItem[]>([]);
  const [activity, setActivity] = useState<ProjectActivityItem[]>([]);
  const [memoryPage, setMemoryPage] = useState(1); const [memoryMore, setMemoryMore] = useState(false);
  const [activityPage, setActivityPage] = useState(1); const [activityMore, setActivityMore] = useState(false);
  const [name, setName] = useState(project.name); const [description, setDescription] = useState(project.description); const [instructions, setInstructions] = useState(project.instructions);
  const [defaultProvider, setDefaultProvider] = useState(project.default_provider_id ?? ''); const [defaultModel, setDefaultModel] = useState(project.default_model ?? '');
  const [memoryDraft, setMemoryDraft] = useState(''); const [fileToAttach, setFileToAttach] = useState(''); const [agentToAssign, setAgentToAssign] = useState(''); const [repoName, setRepoName] = useState('');
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const refreshMemory = useCallback(async (page: number) => { try { const result = await api<{ items: ProjectMemoryItem[]; has_more: boolean }>(`/projects/${project.id}/memory?page=${page}&page_size=20`); setMemories(result.items); setMemoryPage(page); setMemoryMore(result.has_more); } catch (err) { setError(err instanceof Error ? err.message : 'Could not load project memory.'); } }, [project.id]);
  const refreshActivity = useCallback(async (page: number) => { try { const result = await api<{ items: ProjectActivityItem[]; has_more: boolean }>(`/projects/${project.id}/activity?page=${page}&page_size=20`); setActivity(result.items); setActivityPage(page); setActivityMore(result.has_more); } catch (err) { setError(err instanceof Error ? err.message : 'Could not load activity history.'); } }, [project.id]);
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [data, agentData, fileData] = await Promise.all([
        api<ProjectWorkspaceData>(`/projects/${project.id}/workspace`),
        api<{ items: Agent[] }>('/agents'),
        api<{ items: Array<{ id: string; name: string }> }>('/files?page_size=100'),
      ]);
      setWorkspace(data); setAgents(agentData.items); setAvailableFiles(fileData.items);
      setName(data.project.name); setDescription(data.project.description); setInstructions(data.project.instructions);
      setDefaultProvider(data.project.default_provider_id ?? ''); setDefaultModel(data.project.default_model ?? '');
      await Promise.all([refreshMemory(1), refreshActivity(1)]);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load this project workspace.'); }
    finally { setLoading(false); }
  }, [project.id, refreshMemory, refreshActivity]);
  useEffect(() => { void refresh(); }, [refresh]);
  async function runAction(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError('');
    try { await action(); await refresh(); onNotice(success); }
    catch (err) { setError(err instanceof Error ? err.message : 'Workspace action failed.'); }
    finally { setBusy(false); }
  }
  async function saveProject(event: FormEvent) {
    event.preventDefault();
    await runAction(() => api(`/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ name, description, instructions, default_provider_id: defaultProvider || null, default_model: defaultModel }) }), 'Project settings saved.');
  }
  async function addMemory(event: FormEvent) {
    event.preventDefault(); const content = memoryDraft.trim(); if (!content) return;
    await runAction(() => api(`/projects/${project.id}/memory`, { method: 'POST', body: JSON.stringify({ content, source_type: 'user_note' }) }), 'Memory note added.'); setMemoryDraft('');
  }
  async function saveMemory(memory: ProjectMemoryItem) {
    const content = window.prompt('Edit this project memory note', memory.content);
    if (content === null || !content.trim()) return;
    await runAction(() => api(`/projects/${project.id}/memory/${memory.id}`, { method: 'PATCH', body: JSON.stringify({ content: content.trim() }) }), 'Memory note updated.');
  }
  return <section className="page-view project-workspace-view">
    <PageHeading eyebrow="PROJECT WORKSPACE" title={workspace?.project.name ?? project.name} description={workspace?.project.description || 'Project instructions, conversations, private knowledge, and activity.'} action={<button className="button button-secondary" onClick={onBack}><ArrowDown className="back-arrow" size={15}/>All projects</button>}/>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {loading && !workspace ? <div className="loading-state"><span className="spinner"/>Loading project workspace</div> : workspace && <>
      <div className="project-workspace-grid">
        <form className="surface-card project-settings-card" onSubmit={saveProject}>
          <div className="section-title-row"><h2>Instructions & model preferences</h2><span>Private to you</span></div>
          <label>Project name<input required maxLength={100} value={name} onChange={event => setName(event.target.value)}/></label>
          <label>Description<textarea rows={2} maxLength={1000} value={description} onChange={event => setDescription(event.target.value)}/></label>
          <label>Instructions<textarea rows={5} maxLength={6000} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="Goals, context, and how KAVRON should help"/></label>
          <div className="form-row"><label>Default provider<select value={defaultProvider} onChange={event => { setDefaultProvider(event.target.value); setDefaultModel(''); }}><option value="">Use account fallback</option>{providers.filter(item => item.healthy).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Default model<select value={defaultModel} onChange={event => setDefaultModel(event.target.value)}><option value="">Use provider default</option>{models.filter(item => !defaultProvider || item.provider === defaultProvider).map(item => <option key={`${item.provider}:${item.id}`} value={item.id}>{item.id}</option>)}</select></label></div>
          <button className="button button-primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save project settings'}</button>
        </form>
        <div className="surface-card project-conversation-card"><div className="section-title-row"><h2>Conversations</h2><button className="button button-secondary compact" onClick={() => void runAction(async () => { const created = await api<{ id: string }>('/conversations', { method: 'POST', body: JSON.stringify({ title: `New conversation · ${workspace.project.name}`, project_id: project.id }) }); onOpenConversation(created.id, project.id); }, 'Conversation created.')}>New conversation</button></div>
          {workspace.conversations.length ? workspace.conversations.map(item => <div className="project-resource-row" key={item.id}><MessagesSquare size={15}/><span>{item.title}</span><button className="text-link" onClick={() => onOpenConversation(item.id, project.id)}>Open</button></div>) : <p className="muted">No conversations in this project yet.</p>}
        </div>
      </div>
      <div className="project-workspace-grid">
        <section className="surface-card project-resources-card"><div className="section-title-row"><h2>Project files</h2><span>{workspace.files.length} attached</span></div>
          {workspace.files.map(file => <div className="project-resource-row" key={file.id}><Files size={15}/><span>{file.name}</span><button className="quiet-icon" aria-label={`Remove ${file.name} from project`} disabled={busy} onClick={() => void runAction(() => api(`/projects/${project.id}/files/${file.id}`, { method: 'DELETE' }), 'File detached from project.')}><X size={14}/></button></div>)}
          <form className="project-attach-form" onSubmit={event => { event.preventDefault(); if (fileToAttach) void runAction(() => api(`/projects/${project.id}/files`, { method: 'POST', body: JSON.stringify({ file_id: fileToAttach }) }), 'File attached to project.'); }}><select aria-label="Choose a file to attach" value={fileToAttach} onChange={event => setFileToAttach(event.target.value)}><option value="">Choose an uploaded file</option>{availableFiles.filter(file => !workspace.files.some(attached => attached.id === file.id)).map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select><button className="button button-secondary compact" disabled={busy || !fileToAttach}>Attach file</button></form>
          <p className="form-help">Upload files from File workspace, then attach them here. Only files in your account are listed.</p>
        </section>
        <section className="surface-card project-resources-card"><div className="section-title-row"><h2>Assigned agents</h2><span>{workspace.agents.length}</span></div>
          {workspace.agents.map(agent => <div className="project-resource-row" key={agent.id}><Bot size={15}/><span>{agent.name}</span><button className="quiet-icon" aria-label={`Unassign ${agent.name}`} disabled={busy} onClick={() => void runAction(() => api(`/projects/${project.id}/agents/${agent.id}`, { method: 'DELETE' }), 'Agent unassigned.')}><X size={14}/></button></div>)}
          <form className="project-attach-form" onSubmit={event => { event.preventDefault(); if (agentToAssign) void runAction(() => api(`/projects/${project.id}/agents`, { method: 'POST', body: JSON.stringify({ agent_id: agentToAssign }) }), 'Agent assigned to project.'); }}><select aria-label="Choose an agent" value={agentToAssign} onChange={event => setAgentToAssign(event.target.value)}><option value="">Choose a private agent</option>{agents.filter(agent => !workspace.agents.some(item => item.id === agent.id)).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><button className="button button-secondary compact" disabled={busy || !agentToAssign}>Assign agent</button></form>
        </section>
      </div>
      <section className="surface-card project-resources-card"><div className="section-title-row"><h2>Authorized repositories</h2><span>{workspace.repositories.length}</span></div>
        {workspace.repositories.map(repo => <div className="project-resource-row" key={repo.repo_id}><Github size={15}/><span>{repo.full_name}</span><button className="quiet-icon" aria-label={`Unassign ${repo.full_name}`} disabled={busy} onClick={() => void runAction(() => api(`/github/projects/${project.id}/repositories/${repo.repo_id}`, { method: 'DELETE' }), 'Repository unassigned.')}><X size={14}/></button></div>)}
        <form className="project-attach-form" onSubmit={event => { event.preventDefault(); if (repoName.trim()) void runAction(() => api(`/github/projects/${project.id}/repositories`, { method: 'POST', body: JSON.stringify({ repository: repoName.trim() }) }), 'Authorized repository assigned.'); }}><input aria-label="Authorized repository" value={repoName} onChange={event => setRepoName(event.target.value)} placeholder="owner/repository"/><button className="button button-secondary compact" disabled={busy || !repoName.trim()}>Assign repository</button></form>
        <p className="form-help">Only repositories already authorized through your GitHub connection can be assigned.</p>
      </section>
      <section className="surface-card project-resources-card"><div className="section-title-row"><h2>Project memory</h2><span>Inspect, edit, or delete notes used as context.</span></div>
        <form className="project-memory-form" onSubmit={addMemory}><textarea aria-label="New project memory note" maxLength={20000} rows={3} value={memoryDraft} onChange={event => setMemoryDraft(event.target.value)} placeholder="Add a note that should be available in this project's context"/><button className="button button-secondary" disabled={busy || !memoryDraft.trim()}><Plus size={14}/>Add memory</button></form>
        {memories.map(memory => <div className="project-memory-row" key={memory.id}><div><small>{memory.source_type} · updated {new Date(memory.updated_at).toLocaleDateString()}</small><p>{memory.content}</p></div><button className="button button-secondary compact" disabled={busy} onClick={() => void saveMemory(memory)}>Edit</button><button className="quiet-icon" aria-label="Delete project memory" disabled={busy} onClick={() => { if (window.confirm('Delete this project memory note?')) void runAction(() => api(`/projects/${project.id}/memory/${memory.id}`, { method: 'DELETE' }), 'Memory note deleted.'); }}><Trash2 size={14}/></button></div>)}
        <div className="pagination-controls">{memoryPage > 1 && <button className="button button-secondary compact" onClick={() => void refreshMemory(memoryPage - 1)}>Previous</button>}<span>Page {memoryPage}</span>{memoryMore && <button className="button button-secondary compact" onClick={() => void refreshMemory(memoryPage + 1)}>More notes</button>}</div>
      </section>
      <section className="surface-card project-resources-card"><div className="section-title-row"><h2>Activity history</h2><span>Recent project changes</span></div>
        {activity.map((item, index) => <div className="project-activity-row" key={`${item.created_at}:${index}`}><Activity size={14}/><div><strong>{item.action.replaceAll('.', ' ')}</strong><small>{item.resource_type} · {new Date(item.created_at).toLocaleString()}</small>{Object.keys(item.detail).length > 0 && <small>{JSON.stringify(item.detail)}</small>}</div></div>)}
        <div className="pagination-controls">{activityPage > 1 && <button className="button button-secondary compact" onClick={() => void refreshActivity(activityPage - 1)}>Previous</button>}<span>Page {activityPage}</span>{activityMore && <button className="button button-secondary compact" onClick={() => void refreshActivity(activityPage + 1)}>More activity</button>}</div>
      </section>
    </>}
  </section>;
}

function AgentsView({ models, providers, onNotice }: { models: ModelInfo[]; providers: ProviderInfo[]; onNotice: (message: string) => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentPage, setAgentPage] = useState(1); const [agentHasMore, setAgentHasMore] = useState(false); const [agentsLoadingMore, setAgentsLoadingMore] = useState(false);
  const [editing, setEditing] = useState<Agent | null | 'new'>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async (page = 1, append = false) => { if (append) setAgentsLoadingMore(true); try { const data = await api<{ items: Agent[]; has_more: boolean }>(`/agents?page=${page}&page_size=50`); setAgents(current => append ? [...current, ...data.items] : data.items); setAgentPage(page); setAgentHasMore(data.has_more); } catch (err) { setError(err instanceof Error ? err.message : 'Could not load agents.'); } finally { if (append) setAgentsLoadingMore(false); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function remove(agent: Agent) { if (!window.confirm(`Delete agent “${agent.name}” and its run history?`)) return; try { await api(`/agents/${agent.id}`, { method: 'DELETE' }); await refresh(); onNotice('Agent deleted.'); } catch (err) { onNotice(err instanceof Error ? err.message : 'Delete failed.'); } }
  async function duplicate(agent: Agent) { try { await api(`/agents/${agent.id}/duplicate`, { method: 'POST' }); await refresh(); onNotice('Agent duplicated as a private copy.'); } catch (err) { onNotice(err instanceof Error ? err.message : 'Duplicate failed.'); } }
  return <section className="page-view"><PageHeading eyebrow="YOUR CUSTOM WORKFORCE" title="Agent studio" description="Define focused assistants with clear instructions and bounded execution." action={<button className="button button-primary" onClick={() => setEditing('new')}><Plus size={16}/>Create agent</button>}/>
    <div className="notice-card"><Shield size={17}/><div><strong>Bounded by design</strong><p>Agent runs are limited to a single model turn in this release. External actions and arbitrary tool execution are not enabled.</p></div></div>
    {error && <div className="inline-error">{error}</div>}
    {agents.length ? <div className="agent-grid">{agents.map(agent => <AgentCard key={agent.id} agent={agent} models={models} providers={providers} onEdit={() => setEditing(agent)} onDuplicate={() => void duplicate(agent)} onDelete={() => void remove(agent)} onNotice={onNotice}/>)}</div> : <div className="empty-card agent-empty"><div className="empty-icon"><Bot size={21}/></div><h3>Your agents, your rules</h3><p>Create a focused agent for repeatable work. Instructions are private to your account.</p><button className="button button-secondary" onClick={() => setEditing('new')}><Plus size={15}/>Create your first agent</button></div>}{agentHasMore && <button className="button button-secondary" disabled={agentsLoadingMore} onClick={() => void refresh(agentPage + 1, true)}>{agentsLoadingMore ? 'Loading…' : 'Load more agents'}</button>}
    {editing && <AgentEditor agent={editing === 'new' ? null : editing} models={models} onClose={() => setEditing(null)} onSave={async data => { try { if (editing === 'new') await api('/agents', { method: 'POST', body: JSON.stringify(data) }); else await api(`/agents/${editing.id}`, { method: 'PATCH', body: JSON.stringify(data) }); setEditing(null); await refresh(); onNotice(editing === 'new' ? 'Agent created.' : 'Agent updated.'); } catch (err) { throw err; } }}/ >}
  </section>;
}

function AgentCard({ agent, models, providers, onEdit, onDuplicate, onDelete, onNotice }: { agent: Agent; models: ModelInfo[]; providers: ProviderInfo[]; onEdit: () => void; onDuplicate: () => void; onDelete: () => void; onNotice: (message: string) => void }) {
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  async function run(event: FormEvent) { event.preventDefault(); if (!prompt.trim()) return; setRunning(true); setOutput(''); try { const result = await api<{ output: string; model: string }> (`/agents/${agent.id}/run`, { method: 'POST', body: JSON.stringify({ prompt }) }); setOutput(result.output); } catch (err) { onNotice(err instanceof Error ? err.message : 'Agent run failed.'); } finally { setRunning(false); } }
  const providerReady = agent.provider ? providers.some(provider => provider.id === agent.provider && provider.healthy) : providers.some(provider => provider.healthy);
  return <article className="agent-card"><div className="agent-card-top"><div className="agent-avatar"><Bot size={18}/></div><div className="agent-card-actions"><button className="quiet-icon" title="Duplicate agent" onClick={onDuplicate}><Copy size={14}/></button><button className="quiet-icon" title="Delete agent" onClick={onDelete}><Trash2 size={14}/></button></div></div><div className="agent-card-title"><div><h3>{agent.name}</h3><p>{agent.description || 'A personal KAVRON agent'}</p></div><span className="private-tag"><LockKeyhole size={11}/>{agent.visibility}</span></div><div className="agent-instruction-preview">{agent.instructions || 'Add instructions to define how this agent should work.'}</div><div className="agent-meta"><span>{agent.model || 'Auto-select model'}</span><span>1 model turn</span></div><div className="agent-engine-chips"><span>One model turn · no tools</span></div><button className="text-link" onClick={onEdit}>Edit agent <ArrowRight size={14}/></button><form className="agent-test" onSubmit={run}><input aria-label={`Test ${agent.name}`} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Give this agent a quick task…"/><button type="submit" aria-label={`Run ${agent.name}`} disabled={running || !prompt.trim() || !models.length || !providerReady}>{running ? <span className="tiny-spinner"/> : <ArrowUp size={15}/>}</button></form>{!models.length && <p className="agent-config-hint">Connect a model before testing.</p>}{output && <div className="agent-output"><strong>Run result</strong><p>{output}</p></div>}</article>;
}

function AgentEditor({ agent, models, onClose, onSave }: { agent: Agent | null; models: ModelInfo[]; onClose: () => void; onSave: (data: object) => Promise<void> }) {
  const [name, setName] = useState(agent?.name ?? ''); const [description, setDescription] = useState(agent?.description ?? ''); const [instructions, setInstructions] = useState(agent?.instructions ?? ''); const [model, setModel] = useState(agent?.model ?? ''); const [provider, setProvider] = useState(agent?.provider ?? ''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { await onSave({ name, description, instructions, model, provider, enabled_engines: [], visibility: 'private', max_steps: 1 }); } catch (err) { setError(err instanceof Error ? err.message : 'Could not save agent.'); } finally { setBusy(false); } }
  return <div className="modal-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><form className="modal-card agent-editor" onSubmit={save}><div className="modal-heading"><div><span className="eyebrow">AGENT CONFIGURATION</span><h2>{agent ? 'Edit agent' : 'Create an agent'}</h2></div><IconButton label="Close" onClick={onClose}><X size={18}/></IconButton></div><label>Agent name<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="Research partner"/></label><label>Description<input maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} placeholder="What this agent helps you do"/></label><label>System instructions<textarea required minLength={10} maxLength={8000} rows={6} value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="Define role, tone, boundaries, and how to handle uncertainty."/></label><div className="form-row"><label>Default model<select value={model} onChange={e => { const selected = models.find(m => m.id === e.target.value); setModel(e.target.value); setProvider(selected?.provider ?? ''); }}><option value="">Auto-select available</option>{models.map(item => <option key={`${item.provider}-${item.id}`} value={item.id}>{item.id} · {item.provider}</option>)}</select></label><label>Run limit<input value="1 model turn" readOnly/></label></div><div className="notice-card"><Shield size={16}/><div><strong>No external tools are enabled</strong><p>Agent runs use one provider response. Repository actions require the separate approval workflow.</p></div></div>{error && <div className="inline-error">{error}</div>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy || !name.trim() || instructions.trim().length < 10}>{busy ? 'Saving…' : agent ? 'Save changes' : 'Create agent'}<ArrowRight size={15}/></button></div></form></div>;
}

function EngineView({ engines, providers, onRefresh, onNotice }: { engines: EngineInfo[]; providers: ProviderInfo[]; onRefresh: () => Promise<void>; onNotice: (message: string) => void }) {
  const [checking, setChecking] = useState(false);
  async function test() { setChecking(true); try { await onRefresh(); onNotice('Provider health check complete. See current status below.'); } catch { onNotice('Health check failed.'); } finally { setChecking(false); } }
  return <section className="page-view"><PageHeading eyebrow="ROUTING & CAPABILITIES" title="Engine center" description="KAVRON routes requests only to engines whose capabilities and dependencies are configured." action={<button className="button button-secondary" disabled={checking} onClick={() => void test()}><Activity size={15}/>{checking ? 'Checking…' : 'Test connections'}</button>}/><div className="engine-summary"><div className="summary-icon"><Activity size={19}/></div><div><strong>{engines.filter(engine => engine.state === 'ready').length} ready · {engines.filter(engine => engine.state !== 'ready').length} unavailable or not configured</strong><p>Capabilities reflect this account’s provider setup and server configuration. Provider reachability is checked in the Model Library.</p></div></div><div className="engine-list">{engines.map(engine => <article className="engine-row" key={engine.id}><div className={`engine-icon engine-${engine.id}`}><EngineIcon id={engine.id}/></div><div className="engine-info"><div className="engine-name-line"><h3>{engine.name}</h3><span className="engine-version">v{engine.version}</span></div><p>{engine.detail}</p><div className="capability-tags">{engine.capabilities.map(capability => <span key={capability}>{capability}</span>)}</div></div><StatusBadge ready={engine.state === 'ready'}>{engine.state.replaceAll('_', ' ')}</StatusBadge></article>)}</div><div className="provider-list-heading"><h2>Inference providers</h2><span>Server-side configuration</span></div>{providers.map(provider => <div className="provider-row" key={provider.id}><div className="provider-logo">{provider.id === 'ollama' ? <span>O</span> : <Command size={17}/>}</div><div><strong>{provider.name}</strong><p>{provider.configured ? provider.healthy ? `${provider.model_count} models discovered` : provider.error || 'Configured; endpoint health check failed' : 'Not configured on server'}</p></div><StatusBadge ready={provider.healthy}>{provider.healthy ? 'connected' : provider.configured ? 'error' : 'not connected'}</StatusBadge></div>)}<div className="configuration-callout"><Code2 size={17}/><div><strong>Configure a provider server-side</strong><p>Set <code>OLLAMA_BASE_URL</code> or <code>OPENAI_API_KEY</code> and <code>OPENAI_MODEL</code> in the backend environment, then restart the service. Secret values are never returned to the browser.</p></div></div></section>;
}
function EngineIcon({ id }: { id: string }) { if (id === 'chat') return <MessageCircle size={18}/>; if (id === 'knowledge') return <Search size={18}/>; if (id === 'documents') return <Files size={18}/>; if (id === 'vision') return <ImagePlus size={18}/>; if (id === 'image-generation') return <WandSparkles size={18}/>; if (id === 'coding') return <Code2 size={18}/>; if (id === 'web-research') return <Github size={18}/>; return <Sparkles size={18}/>; }

function ModelsView({ models, providers, onRefresh }: { models: ModelInfo[]; providers: ProviderInfo[]; onRefresh: () => Promise<void> }) {
  const [loading, setLoading] = useState(false);
  async function refresh() { setLoading(true); await onRefresh(); setLoading(false); }
  return <section className="page-view"><PageHeading eyebrow="AVAILABLE INFERENCE" title="Model library" description="Only models discovered from a configured provider are listed. KAVRON does not assume every model supports every tool." action={<button className="button button-secondary" onClick={() => void refresh()} disabled={loading}><Activity size={15}/>{loading ? 'Refreshing…' : 'Refresh models'}</button>}/><div className="model-status-banner"><div className="status-orb"><Sparkles size={17}/></div><div><strong>{models.length ? `${models.length} model${models.length === 1 ? '' : 's'} discovered` : 'No models discovered'}</strong><p>{models.length ? 'Discovered from live configured provider endpoints.' : 'Add a provider in the backend environment to make real models available.'}</p></div></div>{models.length ? <div className="model-grid">{models.map(model => <article className="model-card" key={`${model.provider}:${model.id}`}><div className="model-card-top"><span className="model-icon"><Sparkles size={17}/></span><StatusBadge ready>{providers.find(p => p.id === model.provider)?.name ?? model.provider}</StatusBadge></div><h3>{model.id}</h3><p>Capabilities advertised by the provider adapter.</p><div className="capability-tags">{model.capabilities.map(capability => <span key={capability}>{capability}</span>)}</div></article>)}</div> : <div className="provider-empty"><div className="empty-icon"><Command size={20}/></div><h3>A model is a connection, not a label</h3><p>Add a provider in Connected Services or configure one on the server. Models appear after KAVRON successfully discovers them.</p><button className="text-link" onClick={() => window.dispatchEvent(new CustomEvent('kavron:navigate', { detail: 'engines' }))}>Open Engine Center <ArrowRight size={14}/></button></div>}{providers.map(provider => <div className="provider-row compact" key={provider.id}><div className="provider-logo">{provider.id === 'ollama' ? <span>O</span> : <Command size={16}/>}</div><div><strong>{provider.name}</strong><p>{provider.healthy ? 'Endpoint responded successfully.' : provider.configured ? provider.error : 'Configuration required.'}</p></div><StatusBadge ready={provider.healthy}>{provider.healthy ? 'healthy' : provider.configured ? 'unavailable' : 'not configured'}</StatusBadge></div>)}</section>;
}

function ImageStudioView({ engines, onNotice }: { engines: EngineInfo[]; onNotice: (message: string) => void }) {
  const [prompt, setPrompt] = useState(''); const [size, setSize] = useState('1024x1024'); const [image, setImage] = useState<{ image_url: string; prompt: string } | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const configured = engines.find(engine => engine.id === 'image-generation')?.configured ?? false;
  async function generate(event: FormEvent) { event.preventDefault(); if (!prompt.trim()) return; setBusy(true); setError(''); setImage(null); try { const result = await api<{ image_url: string; prompt: string }>('/images/generate', { method: 'POST', body: JSON.stringify({ prompt, size }) }); setImage(result); } catch (err) { setError(err instanceof Error ? err.message : 'Image generation failed.'); onNotice(err instanceof Error ? err.message : 'Image generation failed.'); } finally { setBusy(false); } }
  return <section className="page-view"><PageHeading eyebrow="VISUAL IDEATION" title="Image studio" description="Generate images through a provider you configure. No sample or placeholder images are presented as real results."/><div className="studio-layout"><form className="surface-card studio-form" onSubmit={generate}><div className="card-heading-icon"><ImagePlus size={17}/></div><h2>Describe your image</h2><p>Write a prompt with subject, mood, and composition.</p><label>Prompt<textarea required minLength={3} maxLength={4000} rows={7} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="A quiet observatory above a cloud sea at blue hour…"/></label><label>Aspect ratio<select value={size} onChange={e => setSize(e.target.value)}><option value="1024x1024">Square · 1:1</option><option value="1536x1024">Landscape · 3:2</option><option value="1024x1536">Portrait · 2:3</option></select></label>{!configured && <div className="inline-notice"><CircleHelp size={15}/><span>Configure an image-generation provider in Connected Services, or set <code>OPENAI_API_KEY</code> and <code>OPENAI_IMAGE_MODEL</code> on the server.</span></div>}{error && <div className="inline-error">{error}</div>}<button className="button button-primary full-width" disabled={busy || !prompt.trim() || !configured}>{busy ? <><span className="spinner"/>Generating…</> : <><WandSparkles size={16}/>Generate image</>}</button><p className="form-footnote">Provider charges and limits may apply. Generated assets are kept in your private workspace.</p></form><div className="studio-canvas">{image ? <div className="generated-art"><img src={image.image_url} alt={image.prompt}/><div className="generated-caption"><span>{image.prompt}</span><a href={image.image_url} download="kavron-generated.png" className="button button-secondary"><ArrowDown size={14}/>Download</a></div></div> : <div className="canvas-empty"><div className="canvas-orbit"><ImagePlus size={24}/></div><strong>{busy ? 'Waiting for provider output…' : 'Your canvas'}</strong><p>{busy ? 'The image will appear here when the provider returns a real result.' : 'Generated images will appear here. No image is shown until generation succeeds.'}</p>{busy && <div className="loading-line"><span/></div>}</div>}</div></div></section>;
}

function FilesView({ onNotice }: { onNotice: (message: string) => void }) {
  type FileItem = { id: string; name: string; size_bytes: number; content_type: string; created_at: string; excerpt: string; indexed_chunks: number };
  type IndexJob = { id: string; status: string; progress: number; error: string; cancel_requested?: boolean };
  const [files, setFiles] = useState<FileItem[]>([]);
  const [filePage, setFilePage] = useState(1); const [fileHasMore, setFileHasMore] = useState(false); const [filesLoadingMore, setFilesLoadingMore] = useState(false);
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null); const [busy, setBusy] = useState(false); const [indexJob, setIndexJob] = useState<IndexJob | null>(null); const [indexingFile, setIndexingFile] = useState(''); const [error, setError] = useState(''); const input = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async (page = 1, append = false) => { if (append) setFilesLoadingMore(true); try { const data = await api<{ items: FileItem[]; has_more: boolean }>(`/files?page=${page}&page_size=50`); setFiles(current => append ? [...current, ...data.items] : data.items); setFilePage(page); setFileHasMore(data.has_more); } catch (err) { setError(err instanceof Error ? err.message : 'Could not load files.'); } finally { if (append) setFilesLoadingMore(false); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!indexJob || !['queued', 'running'].includes(indexJob.status)) return;
    let cancelled = false; let timer = 0;
    const poll = async () => {
      try {
        const latest = await api<IndexJob>(`/background-jobs/${indexJob.id}`);
        if (cancelled) return;
        setIndexJob(latest);
        if (['queued', 'running'].includes(latest.status)) timer = window.setTimeout(() => void poll(), 1500);
        else { setIndexingFile(''); await refresh(); if (latest.status === 'complete') onNotice('Document embeddings indexed. Semantic retrieval is available in chats.'); }
      } catch (err) { if (!cancelled) { setError(err instanceof Error ? err.message : 'Could not check indexing job.'); setIndexingFile(''); } }
    };
    void poll(); return () => { cancelled = true; window.clearTimeout(timer); };
  }, [indexJob?.id, indexJob?.status, refresh, onNotice]);
  async function indexFile(id: string) {
    setIndexingFile(id); setError('');
    try { const result = await api<{ job_id: string; status: string }>('/knowledge/index', { method: 'POST', body: JSON.stringify({ file_ids: [id] }) }); setIndexJob({ id: result.job_id, status: result.status, progress: 0, error: '' }); }
    catch (err) { setIndexingFile(''); setError(err instanceof Error ? err.message : 'Could not queue document indexing.'); }
  }
  async function cancelIndex() {
    if (!indexJob) return;
    try { const result = await api<{ status: string; cancel_requested?: boolean }>(`/background-jobs/${indexJob.id}`, { method: 'DELETE' }); setIndexJob({ ...indexJob, status: result.status, cancel_requested: result.cancel_requested }); if (!['queued', 'running'].includes(result.status)) setIndexingFile(''); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not cancel indexing.'); }
  }
  async function upload(file?: File) { if (!file) return; const form = new FormData(); form.append('file', file); setBusy(true); setError(''); try { const result = await api<{ name: string }>('/files', { method: 'POST', body: form }); await refresh(); onNotice(`${result.name} uploaded and text extracted.`); } catch (err) { setError(err instanceof Error ? err.message : 'Upload failed.'); } finally { setBusy(false); if (input.current) input.current.value = ''; } }
  async function openFile(id: string) { try { const result = await api<{ name: string; text: string }>(`/files/${id}`); setPreview({ name: result.name, text: result.text }); } catch (err) { onNotice(err instanceof Error ? err.message : 'Could not open file.'); } }
  async function remove(id: string) { try { await api(`/files/${id}`, { method: 'DELETE' }); await refresh(); onNotice('File deleted.'); } catch (err) { onNotice(err instanceof Error ? err.message : 'Delete failed.'); } }
  return <section className="page-view"><PageHeading eyebrow="PRIVATE WORKSPACE" title="File workspace" description="Upload supported documents to inspect extracted text or attach them to a chat." action={<><input ref={input} type="file" className="visually-hidden" accept=".txt,.md,.markdown,.json,.csv,.py,.ts,.tsx,.js,.jsx,.html,.css,.yaml,.yml,.toml,.sql,.go,.rs,.java,.sh,.xml,.ini,.log,.pdf,.docx" onChange={e => void upload(e.target.files?.[0])}/><button className="button button-primary" onClick={() => input.current?.click()} disabled={busy}><FilePlus2 size={16}/>{busy ? 'Uploading…' : 'Upload file'}</button></>}/><div className="upload-guidance"><Files size={17}/><div><strong>Text extraction is on-device to the server</strong><p>Supported: TXT, Markdown, JSON, CSV, source code, PDF, DOCX. Maximum upload size is set by the server (12 MiB default). Images use Vision instead.</p></div><Shield size={16} className="guidance-shield"/></div>{error && <div className="inline-error">{error}</div>}{indexJob && <div className="inline-notice"><Activity size={15}/><span>Semantic indexing {indexJob.cancel_requested ? 'cancellation requested' : indexJob.status}{['queued', 'running'].includes(indexJob.status) ? ` · ${indexJob.progress}%` : ''}{indexJob.error ? ` · ${indexJob.error}` : ''}</span>{['queued', 'running'].includes(indexJob.status) && <button className="text-link" disabled={indexJob.cancel_requested} onClick={() => void cancelIndex()}>{indexJob.cancel_requested ? 'Cancel requested' : 'Cancel'}</button>}<button className="quiet-icon" aria-label="Dismiss indexing status" onClick={() => setIndexJob(null)}><X size={14}/></button></div>}{files.length ? <div className="files-table"><div className="files-table-head"><span>FILE</span><span>SIZE</span><span>ADDED</span><span/></div>{files.map(file => <div className="file-row" key={file.id}><div className="file-name"><span className="file-type-icon"><Files size={16}/></span><div><button onClick={() => void openFile(file.id)}>{file.name}</button><small>{file.content_type}{file.indexed_chunks ? ` · semantic index: ${file.indexed_chunks} chunks` : ''}</small></div></div><span>{formatBytes(file.size_bytes)}</span><span>{new Date(file.created_at).toLocaleDateString()}</span><div className="file-actions"><button className="button button-secondary compact" disabled={!!indexingFile || busy} onClick={() => void indexFile(file.id)}>{indexingFile === file.id ? 'Indexing…' : 'Index'}</button><button className="quiet-icon" aria-label={`Delete ${file.name}`} onClick={() => void remove(file.id)}><Trash2 size={15}/></button></div></div>)}</div> : <div className="empty-card"><div className="empty-icon"><Files size={20}/></div><h3>No files uploaded</h3><p>Upload a text document or source file. You can attach it to a conversation for analysis.</p><button className="button button-secondary" onClick={() => input.current?.click()}><Plus size={15}/>Upload your first file</button></div>}{fileHasMore && <button className="button button-secondary" disabled={filesLoadingMore} onClick={() => void refresh(filePage + 1, true)}>{filesLoadingMore ? 'Loading…' : 'Load more files'}</button>}{preview && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setPreview(null); }}><div className="modal-card file-preview"><div className="modal-heading"><div><span className="eyebrow">EXTRACTED CONTENT</span><h2>{preview.name}</h2></div><IconButton label="Close preview" onClick={() => setPreview(null)}><X size={18}/></IconButton></div><pre>{preview.text}</pre></div></div>}</section>;
}

function GitHubView({ onNotice }: { onNotice: (message: string) => void }) {
  type Repo = { id: string; full_name: string; default_branch: string; private: boolean; last_indexed_at?: string; indexed_files?: number; sync_status?: string | null };
  type Job = { id: string; status: string; progress: number; error: string; lfs_pointer_count?: number; cancel_requested?: boolean };
  type GitAction = { id: string; full_name: string; action_type: string; status: string; action: Record<string, unknown>; result?: Record<string, unknown>; error?: string };
  const [status, setStatus] = useState<{ configured: boolean; connected: boolean; login?: string } | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]); const [repoName, setRepoName] = useState(''); const selectedRepo = repos.find(repo => repo.full_name === repoName);
  const [branches, setBranches] = useState<{ name: string; protected: boolean }[]>([]); const [branch, setBranch] = useState('');
  const [commits, setCommits] = useState<{ sha: string; message: string; author: string; date: string }[]>([]); const [tree, setTree] = useState<{ path: string; type: string; size: number; sha: string }[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]); const [agentId, setAgentId] = useState(''); const [task, setTask] = useState(''); const [agentOutput, setAgentOutput] = useState('');
  const [actions, setActions] = useState<GitAction[]>([]); const [job, setJob] = useState<Job | null>(null); const [jobId, setJobId] = useState('');
  const [searchQuery, setSearchQuery] = useState(''); const [searchResults, setSearchResults] = useState<{ path: string; html_url?: string; snippet?: string; score?: number }[]>([]);
  const [actionType, setActionType] = useState<'create_branch' | 'commit_files' | 'create_pull_request'>('commit_files'); const [newBranch, setNewBranch] = useState('feature/kavron-change'); const [baseBranch, setBaseBranch] = useState(''); const [filePath, setFilePath] = useState(''); const [fileContent, setFileContent] = useState(''); const [deleteFile, setDeleteFile] = useState(false); const [commitMessage, setCommitMessage] = useState('Proposed change'); const [prTitle, setPrTitle] = useState('Proposed change');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const current = await api<{ configured: boolean; connected: boolean; login?: string }>('/github/status'); setStatus(current);
      if (current.connected) {
        const [repoData, agentData, actionData] = await Promise.all([api<{ items: Repo[] }>('/github/repositories'), api<{ items: Agent[] }>('/agents'), api<{ items: GitAction[] }>('/github/actions')]);
        setRepos(repoData.items); setAgents(agentData.items); setActions(actionData.items); setRepoName(previous => previous || repoData.items[0]?.full_name || '');
      } else { setRepos([]); setRepoName(''); }
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load GitHub status.'); }
  }, []);
  useEffect(() => { void refresh(); const params = new URLSearchParams(window.location.search); if (params.get('github')) { onNotice('GitHub authorization returned. Loading authorized installations…'); window.history.replaceState({}, '', window.location.pathname); } }, [refresh, onNotice]);
  useEffect(() => {
    if (!selectedRepo) return;
    const load = async () => {
      try {
        const [branchData, commitData, treeData] = await Promise.all([
          api<{ items: typeof branches }>(`/github/repositories/${encodeURIComponent(selectedRepo.full_name.split('/')[0])}/${encodeURIComponent(selectedRepo.full_name.split('/')[1])}/branches`),
          api<{ items: typeof commits }>(`/github/repositories/${encodeURIComponent(selectedRepo.full_name.split('/')[0])}/${encodeURIComponent(selectedRepo.full_name.split('/')[1])}/commits?branch=${encodeURIComponent(branch || selectedRepo.default_branch)}`),
          api<{ items: typeof tree }>(`/github/repositories/${encodeURIComponent(selectedRepo.full_name.split('/')[0])}/${encodeURIComponent(selectedRepo.full_name.split('/')[1])}/tree?branch=${encodeURIComponent(branch || selectedRepo.default_branch)}`),
        ]);
        setBranches(branchData.items); setCommits(commitData.items); setTree(treeData.items.slice(0, 50));
        if (!branch) setBranch(selectedRepo.default_branch);
      } catch (err) { setError(err instanceof Error ? err.message : 'Could not browse repository.'); }
    };
    void load();
  }, [selectedRepo?.full_name, branch]);
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false; let timer = 0;
    const poll = async () => {
      try {
        const latest = await api<Job>(`/github/jobs/${jobId}`); if (cancelled) return; setJob(latest);
        if (['queued', 'running'].includes(latest.status)) timer = window.setTimeout(() => void poll(), 2000);
        else { setJobId(''); await refresh(); }
      } catch (err) { if (!cancelled) { setError(err instanceof Error ? err.message : 'Could not check index job.'); setJobId(''); } }
    };
    void poll(); return () => { cancelled = true; window.clearTimeout(timer); };
  }, [jobId, refresh]);
  async function connect() { setBusy(true); try { const result = await api<{ authorization_url: string }>('/github/connect/start', { method: 'POST' }); window.location.assign(result.authorization_url); } catch (err) { setError(err instanceof Error ? err.message : 'GitHub App is not configured.'); setBusy(false); } }
  async function disconnect() { if (!window.confirm('Disconnect GitHub and revoke the stored authorization? Your indexed private code will be deleted.')) return; setBusy(true); try { const result = await api<{ revoked: boolean }>('/github/disconnect', { method: 'POST' }); setRepos([]); setStatus({ configured: status?.configured ?? false, connected: false }); await refresh(); onNotice(result.revoked ? 'GitHub disconnected and authorization revoked.' : 'Local GitHub credentials were removed; remote revocation was not confirmed. Revoke the app in GitHub settings if needed.'); } catch (err) { setError(err instanceof Error ? err.message : 'Disconnect failed.'); } finally { setBusy(false); } }
  async function indexRepo() { if (!selectedRepo) return; const [owner, repo] = selectedRepo.full_name.split('/'); setBusy(true); try { const result = await api<{ job_id: string; status: string }>(`/github/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/index?branch=${encodeURIComponent(branch || selectedRepo.default_branch)}`, { method: 'POST' }); setJobId(result.job_id); setJob({ id: result.job_id, status: 'queued', progress: 0, error: '' }); onNotice('Repository indexing queued.'); } catch (err) { setError(err instanceof Error ? err.message : 'Could not queue indexing.'); } finally { setBusy(false); } }
  async function searchRepository(event: FormEvent) { event.preventDefault(); if (!selectedRepo || !searchQuery.trim()) return; const [owner, repo] = selectedRepo.full_name.split('/'); setBusy(true); setError(''); try { const result = await api<{ items: typeof searchResults }>(`/github/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/code-search?q=${encodeURIComponent(searchQuery)}`); setSearchResults(result.items); } catch (err) { setError(err instanceof Error ? err.message : 'Repository search failed.'); } finally { setBusy(false); } }
  async function runAgent(event: FormEvent) { event.preventDefault(); if (!selectedRepo || !task.trim() || !agentId) return; const [owner, repo] = selectedRepo.full_name.split('/'); setBusy(true); setError(''); setAgentOutput(''); try { const result = await api<{ output: string }>(`/github/agents/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/run`, { method: 'POST', body: JSON.stringify({ agent_id: agentId, task }) }); setAgentOutput(result.output); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : 'Repository agent failed.'); } finally { setBusy(false); } }
  async function proposeAction(event: FormEvent) { event.preventDefault(); if (!selectedRepo) return; setBusy(true); setError(''); try { const body: Record<string, unknown> = { repository: selectedRepo.full_name, action_type: actionType, branch: newBranch, base_branch: baseBranch || branch || selectedRepo.default_branch, commit_message: commitMessage, title: prTitle, body: 'Proposed by KAVRON. Review the diff and checks before merging.' }; if (actionType === 'commit_files') body.changes = [{ path: filePath, delete: deleteFile, content: fileContent }]; await api('/github/actions/propose', { method: 'POST', body: JSON.stringify(body) }); await refresh(); onNotice('Repository action is pending your explicit approval.'); } catch (err) { setError(err instanceof Error ? err.message : 'Could not propose repository action.'); } finally { setBusy(false); } }
  async function approveAction(action: GitAction) { if (!window.confirm(`Approve ${action.action_type} for ${action.full_name}? This will mutate the repository.`)) return; try { await api(`/github/actions/${action.id}/approve`, { method: 'POST', body: JSON.stringify({ confirm: true }) }); await refresh(); onNotice('Approved GitHub action executed.'); } catch (err) { onNotice(err instanceof Error ? err.message : 'Action failed.'); await refresh(); } }
  return <section className="page-view"><PageHeading eyebrow="AUTHORIZED REPOSITORY WORKSPACE" title="GitHub" description="Browse and index repositories granted to your GitHub App installation. Repository writes require explicit approval." action={status?.connected ? <button className="button button-secondary" onClick={() => void disconnect()} disabled={busy}>Disconnect GitHub</button> : <button className="button button-primary" onClick={() => void connect()} disabled={busy}><Github size={16}/>{busy ? 'Connecting…' : 'Connect GitHub App'}</button>}/>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {!status?.connected ? <div className="github-connect-card"><div className="github-big-icon"><Github size={25}/></div><div className="github-card-copy"><StatusBadge ready={false}>{status?.configured ? 'not connected' : 'configuration required'}</StatusBadge><h2>{status?.configured ? 'Authorize your GitHub App installation' : 'GitHub App setup is required'}</h2><p>Only repositories available to your GitHub App installation are listed. App permissions should be configured minimally: metadata/read contents and contents/pull-request write only if you need approved actions.</p><div className="github-list"><span><Check size={14}/>OAuth state is one-time and tied to your signed-in KAVRON account</span><span><Check size={14}/>Repository installation tokens are scoped to one repository and not persisted</span><span><X size={14}/>Private code is indexed only within your account</span></div>{!status?.configured && <p className="admin-note">Set GITHUB_APP_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_PRIVATE_KEY, and KAVRON_ENCRYPTION_KEY on the server.</p>}</div></div> : <>
      <div className="github-toolbar"><StatusBadge ready>{`Connected as ${status.login ?? 'GitHub user'}`}</StatusBadge><label className="model-select"><select value={repoName} onChange={e => { setRepoName(e.target.value); setBranch(''); }}><option value="">Choose an authorized repository</option>{repos.map(repo => <option key={repo.id} value={repo.full_name}>{repo.full_name}{repo.private ? ' · private' : ''}</option>)}</select><ChevronDown size={13}/></label><button className="button button-secondary" onClick={() => void refresh()}><Activity size={15}/>Refresh installations</button></div>
      {selectedRepo && <div className="github-workspace-grid"><div className="surface-card github-repo-card"><div className="section-title-row"><div><h2>{selectedRepo.full_name}</h2><p>{selectedRepo.private ? 'Private repository' : 'Public repository'} · {selectedRepo.indexed_files ?? 0} indexed source files {selectedRepo.sync_status ? `· ${selectedRepo.sync_status}` : ''}</p></div><button className="button button-primary" onClick={() => void indexRepo()} disabled={busy || !!jobId}>Index / sync</button></div><label>Branch<select value={branch || selectedRepo.default_branch} onChange={e => setBranch(e.target.value)}>{branches.map(item => <option key={item.name} value={item.name}>{item.name}{item.protected ? ' · protected' : ''}</option>)}</select></label>{job && <div className="github-job-status"><strong>Index {job.status}</strong><progress max="100" value={job.progress}/><span>{job.progress}% {job.lfs_pointer_count ? `· ${job.lfs_pointer_count} Git LFS pointer(s) detected (not downloaded)` : ''}{job.cancel_requested ? ' · cancellation requested' : ''}</span>{job.error && <p>{job.error}</p>}{jobId && <button className="text-link" disabled={job.cancel_requested} onClick={() => void api<{ status: string; cancel_requested?: boolean }>(`/github/jobs/${jobId}`, { method: 'DELETE' }).then(result => { setJob(current => current ? { ...current, status: result.status, cancel_requested: result.cancel_requested } : current); if (!['queued', 'running'].includes(result.status)) setJobId(''); })}>{job.cancel_requested ? 'Cancel requested' : 'Cancel indexing'}</button>}</div>}<h3>Repository tree</h3><div className="repo-tree-list">{tree.map(item => <div key={item.path}><Code2 size={14}/><span>{item.path}</span><small>{item.type === 'blob' ? formatBytes(item.size) : 'directory'}</small></div>)}</div><h3>Recent commits</h3><div className="repo-commits">{commits.slice(0, 8).map(commit => <div key={commit.sha}><strong>{commit.message}</strong><small>{commit.author} · {new Date(commit.date).toLocaleDateString()} · {commit.sha.slice(0, 7)}</small></div>)}</div></div>
        <div className="github-side-tools"><form className="surface-card github-search-card" onSubmit={searchRepository}><h2>Search repository code</h2><div className="inline-search"><input required value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search code"/><button className="button button-secondary" disabled={busy}><Search size={15}/>Search</button></div>{searchResults.map(item => <a className="github-search-result" key={item.path} href={item.html_url} target="_blank" rel="noreferrer"><Code2 size={14}/>{item.path}</a>)}</form>
          <form className="surface-card github-agent-card" onSubmit={runAgent}><h2>Repository agent</h2><p>Analyze indexed source, explain code, find bugs or draft a patch. No change is applied automatically.</p><label>Agent<select required value={agentId} onChange={e => setAgentId(e.target.value)}><option value="">Choose an agent</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><label>Task<textarea required maxLength={10000} value={task} onChange={e => setTask(e.target.value)} placeholder="Review authentication for likely bugs…"/></label><button className="button button-secondary" disabled={busy || !agents.length}>Run analysis</button>{agentOutput && <pre className="agent-output">{agentOutput}</pre>}</form>
        </div>
      </div>}
      {selectedRepo && <><form className="surface-card github-action-form" onSubmit={proposeAction}><h2>Propose repository action</h2><p>Every write is queued for your review. Approving creates a branch, commit, or draft pull request using repository-scoped App permissions.</p><div className="provider-form-grid"><label>Action<select value={actionType} onChange={e => setActionType(e.target.value as typeof actionType)}><option value="commit_files">Commit/update one text file</option><option value="create_branch">Create branch</option><option value="create_pull_request">Open draft pull request</option></select></label><label>Branch<input required value={newBranch} onChange={e => setNewBranch(e.target.value)}/></label><label>Base branch<input value={baseBranch || selectedRepo.default_branch} onChange={e => setBaseBranch(e.target.value)}/></label>{actionType === 'commit_files' && <><label>Commit message<input required value={commitMessage} onChange={e => setCommitMessage(e.target.value)}/></label><label>File path<input required value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="src/example.ts"/></label><label className="check-label"><input type="checkbox" checked={deleteFile} onChange={e => setDeleteFile(e.target.checked)}/>Delete this file (requires review)</label>{!deleteFile && <label className="provider-wide">Replacement file contents<textarea required rows={8} value={fileContent} onChange={e => setFileContent(e.target.value)}/></label>}</>}{actionType === 'create_pull_request' && <label>Pull request title<input required value={prTitle} onChange={e => setPrTitle(e.target.value)}/></label>}</div><button className="button button-secondary" disabled={busy}>Create approval proposal</button></form><div className="surface-card github-actions-list"><h2>Pending and recent repository actions</h2>{actions.length ? actions.map(action => <div className="github-action-row" key={action.id}><div><strong>{action.action_type.replaceAll('_', ' ')} · {action.full_name}</strong><small>{action.status}{action.error ? ` · ${action.error}` : ''}</small><pre>{JSON.stringify(action.action, null, 2)}</pre></div>{action.status === 'awaiting_approval' && <button className="button button-primary" onClick={() => void approveAction(action)}>Review & approve</button>}</div>) : <p>No repository actions proposed.</p>}</div></>}
      {!repos.length && <div className="empty-card"><h3>No repositories available</h3><p>Install the KAVRON GitHub App on a repository and grant the minimum required permissions.</p></div>}
    </>}
  </section>;
}

function ServicesView({ providers, onRefresh, onNotice }: { providers: ProviderInfo[]; onRefresh: () => Promise<void>; onNotice: (message: string) => void }) {
  const [name, setName] = useState(''); const [kind, setKind] = useState<'openai-compatible' | 'ollama'>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1'); const [model, setModel] = useState(''); const [apiKey, setApiKey] = useState('');
  const [visionModel, setVisionModel] = useState(''); const [imageModel, setImageModel] = useState(''); const [embeddingModel, setEmbeddingModel] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>(['chat', 'streaming']);
  const [contextLength, setContextLength] = useState('8192'); const [priority, setPriority] = useState('100'); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api('/providers', { method: 'POST', body: JSON.stringify({ name, kind, base_url: baseUrl, model, api_key: apiKey, vision_model: visionModel, image_model: imageModel, embedding_model: embeddingModel, context_length: Number(contextLength), capabilities, fallback_priority: Number(priority), enabled: true }) });
      setName(''); setModel(''); setApiKey(''); setVisionModel(''); setImageModel(''); setEmbeddingModel(''); await onRefresh(); onNotice('Provider saved. Credentials are encrypted server-side.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save provider.'); }
    finally { setBusy(false); }
  }
  async function setDefault(provider: ProviderInfo) {
    try {
      if (provider.id.startsWith('user:')) await api(`/providers/${provider.id.split(':')[1]}`, { method: 'PATCH', body: JSON.stringify({ is_default: true }) });
      else await api('/auth/preferences', { method: 'PATCH', body: JSON.stringify({ default_provider_id: provider.id, default_model: provider.model ?? '' }) });
      onNotice(`${provider.name} is now your default provider.`);
    } catch (err) { onNotice(err instanceof Error ? err.message : 'Could not set default provider.'); }
  }
  async function updateProvider(provider: ProviderInfo, patch: { enabled?: boolean; fallback_priority?: number }) {
    if (!provider.id.startsWith('user:')) return;
    try { await api(`/providers/${provider.id.split(':')[1]}`, { method: 'PATCH', body: JSON.stringify(patch) }); await onRefresh(); onNotice('Provider settings updated.'); }
    catch (err) { onNotice(err instanceof Error ? err.message : 'Could not update provider.'); }
  }
  async function remove(provider: ProviderInfo) {
    if (!provider.id.startsWith('user:') || !window.confirm(`Remove provider ${provider.name}?`)) return;
    try { await api(`/providers/${provider.id.split(':')[1]}`, { method: 'DELETE' }); await onRefresh(); onNotice('Provider removed.'); }
    catch (err) { onNotice(err instanceof Error ? err.message : 'Could not remove provider.'); }
  }
  return <section className="page-view"><PageHeading eyebrow="INTEGRATIONS" title="Providers & services" description="Configure compatible endpoints, inspect live availability and select a fallback priority."/><div className="service-list">{providers.map(provider => <div className="service-card" key={provider.id}><div className="service-symbol">{provider.id.toLowerCase().includes('ollama') ? 'O' : <Command size={18}/>}</div><div className="service-copy"><h3>{provider.name}</h3><p>{provider.healthy ? `${provider.model_count} live models · ${provider.capabilities?.join(', ') ?? 'chat'}${provider.context_length ? ` · ${provider.context_length.toLocaleString()} context` : ''}` : provider.error || (provider.configured ? 'Endpoint is configured, but not healthy.' : 'Not configured')}</p>{provider.base_url && <small>{provider.base_url}</small>}{provider.fallback_priority !== undefined && <small>Fallback priority {provider.fallback_priority}</small>}</div><StatusBadge ready={provider.healthy}>{provider.healthy ? 'healthy' : provider.enabled === false ? 'disabled' : provider.configured ? 'unavailable' : 'not configured'}</StatusBadge>{provider.healthy && <button className="button button-secondary compact" onClick={() => void setDefault(provider)}>Set default</button>}{provider.id.startsWith('user:') && <><label className="priority-control">Priority<input aria-label={`${provider.name} fallback priority`} type="number" min={0} max={10000} defaultValue={provider.fallback_priority ?? 100} onBlur={event => { const next = Number(event.currentTarget.value); if (Number.isInteger(next) && next !== provider.fallback_priority) void updateProvider(provider, { fallback_priority: next }); }}/></label><button className="button button-secondary compact" onClick={() => void updateProvider(provider, { enabled: !provider.enabled })}>{provider.enabled ? 'Disable' : 'Enable'}</button><button className="quiet-icon" aria-label={`Remove ${provider.name}`} onClick={() => void remove(provider)}><Trash2 size={15}/></button></>}</div>)}</div>
    <form className="surface-card provider-create-form" onSubmit={create}><h2>Add a provider</h2><p>Optional API keys are sent only to the server and stored using the configured Fernet encryption key. Never enter a provider key in an untrusted deployment.</p><div className="provider-form-grid"><label>Display name<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="My compatible endpoint"/></label><label>Provider type<select value={kind} onChange={e => { const next = e.target.value as typeof kind; setKind(next); setBaseUrl(next === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'); }}><option value="openai-compatible">OpenAI-compatible</option><option value="ollama">Ollama</option></select></label><label className="provider-wide">Base URL<input required value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1"/></label><label>Chat model ID<input required maxLength={200} value={model} onChange={e => setModel(e.target.value)} placeholder="model identifier"/></label><label>API key<input type="password" autoComplete="new-password" maxLength={1000} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={kind === 'ollama' ? 'Optional' : 'Required for this endpoint'}/></label><label>Vision model ID<input maxLength={200} value={visionModel} onChange={e => setVisionModel(e.target.value)} placeholder="Optional"/></label><label>Image model ID<input maxLength={200} value={imageModel} onChange={e => setImageModel(e.target.value)} placeholder="Optional"/></label><label>Embedding model ID<input maxLength={200} value={embeddingModel} onChange={e => setEmbeddingModel(e.target.value)} placeholder="Optional; for vector indexing"/></label><label>Context length<input type="number" min={512} max={2000000} value={contextLength} onChange={e => setContextLength(e.target.value)}/></label><label>Fallback priority<input type="number" min={0} max={10000} value={priority} onChange={e => setPriority(e.target.value)}/></label><fieldset className="provider-wide capability-choices"><legend>Advertised capabilities</legend>{[['chat', 'Chat'], ['streaming', 'Streaming'], ['vision', 'Vision'], ['image-generation', 'Image generation'], ['embeddings', 'Embeddings']].map(([value, label]) => <label className="check-label" key={value}><input type="checkbox" disabled={value === 'chat'} checked={capabilities.includes(value)} onChange={event => setCapabilities(current => event.target.checked ? [...current, value] : current.filter(item => item !== value))}/>{label}</label>)}</fieldset></div>{error && <div className="inline-error" role="alert">{error}</div>}<button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save provider'}<ArrowRight size={15}/></button></form>
    <div className="notice-card"><Shield size={17}/><div><strong>Capability-gated routing</strong><p>Chat selects only discovered chat models. Personal endpoints are restricted to HTTPS (or loopback Ollama); environment credentials remain server-side.</p></div></div><p className="service-footnote">GitHub App authorization, Tavily, vision and image adapters have separate configuration. Provider key values are never returned from the API.</p></section>;
}

function SettingsView({ user, theme, onTheme, onLogout, onNotice, onProfileUpdate }: { user: User; theme: Theme; onTheme: (theme: Theme) => void; onLogout: () => void; onNotice: (message: string) => void; onProfileUpdate: (user: User) => void }) {
  type SessionInfo = { id: string; created_at: string; expires_at: string; current: boolean; revoked: boolean };
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [profileName, setProfileName] = useState(user.name); const [sessions, setSessions] = useState<SessionInfo[]>([]); const [currentPassword, setCurrentPassword] = useState(''); const [newPassword, setNewPassword] = useState('');
  const refreshSessions = useCallback(() => api<{ items: SessionInfo[] }>('/auth/sessions').then(result => setSessions(result.items)).catch(err => setError(err.message)), []);
  useEffect(() => { setProfileName(user.name); void refreshSessions(); }, [user.id, user.name, refreshSessions]);
  async function saveProfile(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await api<{ user: User }>('/auth/profile', { method: 'PATCH', body: JSON.stringify({ name: profileName }) }); onProfileUpdate(result.user); onNotice('Profile updated.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not update your profile.'); }
    finally { setBusy(false); }
  }
  async function changePassword(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/auth/password/change', { method: 'POST', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) }); setCurrentPassword(''); setNewPassword(''); await refreshSessions(); onNotice('Password changed; other sessions were revoked.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not change your password.'); }
    finally { setBusy(false); }
  }
  async function revokeSession(session: SessionInfo) {
    if (session.current || !window.confirm('Revoke this session?')) return;
    setBusy(true); setError('');
    try { await api(`/auth/sessions/${session.id}`, { method: 'DELETE' }); await refreshSessions(); onNotice('Session revoked.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not revoke session.'); }
    finally { setBusy(false); }
  }
  async function exportData() {
    setBusy(true); setError('');
    try {
      const data = await api<Record<string, unknown>>('/privacy/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `kavron-account-export-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
      onNotice('Your account export was downloaded.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not export account data.'); }
    finally { setBusy(false); }
  }
  async function deleteAccount() {
    if (!window.confirm('Permanently delete your KAVRON account, conversations, projects, agents, provider credentials, indexed data, and stored uploads? This cannot be undone.')) return;
    setBusy(true); setError('');
    try { await api('/privacy/account', { method: 'DELETE' }); onNotice('Account deleted.'); await onLogout(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Account deletion failed. Stored data cleanup may need to be retried.'); }
    finally { setBusy(false); }
  }
  return <section className="page-view"><PageHeading eyebrow="PERSONAL PREFERENCES" title="Settings" description="Manage your workspace appearance and account session."/><div className="settings-grid"><div className="surface-card settings-card"><div className="settings-card-heading"><div className="settings-icon"><Sun size={17}/></div><div><h2>Appearance</h2><p>Choose a comfortable theme for your workspace.</p></div></div><div className="theme-choices"><button className={theme === 'dark' ? 'selected' : ''} onClick={() => onTheme('dark')}><div className="theme-preview theme-preview-dark"><span/><span/><span/></div><span>Dark</span>{theme === 'dark' && <Check size={15}/>}</button><button className={theme === 'light' ? 'selected' : ''} onClick={() => onTheme('light')}><div className="theme-preview theme-preview-light"><span/><span/><span/></div><span>Light</span>{theme === 'light' && <Check size={15}/>}</button></div></div><div className="surface-card settings-card"><div className="settings-card-heading"><div className="settings-icon"><LockKeyhole size={17}/></div><div><h2>Account</h2><p>Your account details and current role.</p></div></div><div className="account-detail"><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><p>{user.email}</p><small>{user.role === 'admin' ? 'Administrator' : 'Personal account'}</small></div></div><form className="settings-inline-form" onSubmit={saveProfile}><label>Display name<input required minLength={1} maxLength={100} value={profileName} onChange={event => setProfileName(event.target.value)}/></label><button className="button button-secondary" disabled={busy || profileName.trim() === user.name}>{busy ? 'Saving…' : 'Save profile'}</button></form><button className="button button-secondary logout-button" onClick={onLogout}><LogOut size={15}/>Sign out of KAVRON</button></div><div className="surface-card settings-card account-security-card"><div className="settings-card-heading"><div className="settings-icon"><LockKeyhole size={17}/></div><div><h2>Password & sessions</h2><p>Change your password and revoke other active sessions.</p></div></div><form className="settings-password-form" onSubmit={changePassword}><label>Current password<input type="password" required autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)}/></label><label>New password<input type="password" required minLength={10} maxLength={256} autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)}/></label><button className="button button-secondary" disabled={busy || newPassword.length < 10}>{busy ? 'Updating…' : 'Change password'}</button></form><div className="session-list"><h3>Active sessions</h3>{sessions.filter(session => !session.revoked).map(session => <div className="session-row" key={session.id}><div><strong>{session.current ? 'This session' : 'Other session'}</strong><small>Started {new Date(session.created_at).toLocaleString()} · expires {new Date(session.expires_at).toLocaleString()}</small></div>{!session.current && <button className="quiet-icon" aria-label="Revoke session" disabled={busy} onClick={() => void revokeSession(session)}><Trash2 size={14}/></button>}</div>)}</div></div><div className="surface-card settings-card privacy-card"><div className="settings-card-heading"><div className="settings-icon"><Shield size={17}/></div><div><h2>Privacy & account data</h2><p>Review or delete the data held in your account.</p></div></div><p>Your export includes profile, projects, conversations and messages, extracted upload text, agents, project memory, activity, preferences, and authorized repository names. Account deletion also removes managed local/S3 files; if object storage is unavailable, deletion is stopped so it can be retried.</p><div className="privacy-actions"><button className="button button-secondary" disabled={busy} onClick={() => void exportData()}><Download size={15}/>{busy ? 'Working…' : 'Download my data'}</button><button className="button button-danger" disabled={busy} onClick={() => void deleteAccount()}><Trash2 size={15}/>Delete account</button></div>{error && <div className="inline-error" role="alert">{error}</div>}</div></div></section>;
}

function AdminView({ user }: { user: User }) {
  const [data, setData] = useState<{ counts: Record<string, number>; engines: EngineInfo[]; providers: ProviderInfo[] } | null>(null); const [error, setError] = useState('');
  useEffect(() => { if (user.role !== 'admin') return; api<typeof data>('/admin/overview').then(result => setData(result)).catch(err => setError(err.message)); }, [user.role]);
  if (user.role !== 'admin') return <section className="page-view"><div className="empty-card"><Shield size={22}/><h3>Administrator access required</h3></div></section>;
  return <section className="page-view"><PageHeading eyebrow="SYSTEM OPERATIONS" title="Admin console" description="A lightweight overview of configured services and local workspace records."/>{error && <div className="inline-error">{error}</div>}{data ? <><div className="metric-grid">{Object.entries(data.counts).map(([key, value]) => <div className="metric-card" key={key}><span>{key}</span><strong>{value}</strong></div>)}</div><h2 className="admin-section-title">Engine health</h2><div className="engine-list">{data.engines.map(engine => <div className="provider-row" key={engine.id}><div className="engine-icon"><EngineIcon id={engine.id}/></div><div><strong>{engine.name}</strong><p>{engine.detail}</p></div><StatusBadge ready={engine.state === 'ready'}>{engine.state.replaceAll('_', ' ')}</StatusBadge></div>)}</div></> : !error && <div className="loading-state"><span className="spinner"/>Loading system overview</div>}</section>;
}

function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB`; }

export default App;
