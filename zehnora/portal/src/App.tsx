import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BarChart3, BookOpen, Boxes, KeyRound, LogOut, MessageSquare, Server, Users, type LucideIcon } from 'lucide-react';
import brand from '@brand/brand.json';
import { api, ApiError, type Me } from './api';
import AuthPage from './pages/Auth';
import Dashboard from './pages/Dashboard';
import Keys from './pages/Keys';
import Models from './pages/Models';
import Playground from './pages/Playground';
import Docs from './pages/Docs';
import AdminUsers from './pages/AdminUsers';
import AdminUser from './pages/AdminUser';
import AdminSystem from './pages/AdminSystem';

interface Session { me: Me | null; refresh: () => Promise<void>; setMe: (m: Me | null) => void }
const SessionContext = createContext<Session>({ me: null, refresh: async () => {}, setMe: () => {} });
export const useSession = () => useContext(SessionContext);

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await api.get<Me & { authenticated: boolean }>('/session');
      setMe(s.authenticated ? s : null);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setMe(null);
      else throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (loading) return <div className="boot"><span className="mark">{brand.productName[0]}</span></div>;

  return (
    <SessionContext.Provider value={{ me, refresh, setMe }}>
      {me ? <Shell /> : (
        <Routes>
          <Route path="/register" element={<AuthPage mode="register" />} />
          <Route path="*" element={<AuthPage mode="login" />} />
        </Routes>
      )}
    </SessionContext.Provider>
  );
}

function NavItem({ to, icon: Icon, label, end }: { to: string; icon: LucideIcon; label: string; end?: boolean }) {
  return <NavLink to={to} end={end}><Icon size={16} strokeWidth={1.75} />{label}</NavLink>;
}

function Shell() {
  const { me, setMe } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const logout = async () => {
    try { await api.post('/auth/logout'); } finally { setMe(null); navigate('/'); }
  };
  const isAdmin = me?.user.role === 'admin';
  return (
    <div className={`layout ${pathname.startsWith('/playground') ? 'full' : ''}`}>
      <aside className="sidebar">
        <div className="logo"><span className="mark">{brand.productName[0]}</span>{brand.productName}<span className="logo-sub">Platform</span></div>
        <nav>
          <NavItem to="/playground" icon={MessageSquare} label="Playground" />
          <div className="nav-group">Build</div>
          <NavItem to="/keys" icon={KeyRound} label="API keys" />
          <NavItem to="/models" icon={Boxes} label="Models" />
          <NavItem to="/docs" icon={BookOpen} label="Quickstart" />
          <div className="nav-group">Account</div>
          <NavItem to="/" icon={BarChart3} label="Usage" end />
          {isAdmin && <div className="nav-group">Admin</div>}
          {isAdmin && <NavItem to="/admin/users" icon={Users} label="Users & credits" />}
          {isAdmin && <NavItem to="/admin/system" icon={Server} label="Models & requests" />}
        </nav>
        <div className="sidebar-foot">
          {me?.profile !== 'gpu' && <div className="badge warn" title="This deployment does not use the GPU model">profile: {me?.profile}</div>}
          <div className="credits-line"><span className="muted">Credits</span><strong>{me ? me.wallet.available_credits.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}</strong></div>
          <div className="account">
            <span className="avatar">{me?.user.email[0].toUpperCase()}</span>
            <span className="email" title={me?.user.email}>{me?.user.email}</span>
            <button className="ghost icon" onClick={logout} aria-label="Log out" title="Log out"><LogOut size={15} /></button>
          </div>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/keys" element={<Keys />} />
          <Route path="/models" element={<Models />} />
          <Route path="/playground" element={<Playground />} />
          <Route path="/playground/:id" element={<Playground />} />
          <Route path="/docs" element={<Docs />} />
          {isAdmin && <Route path="/admin/users" element={<AdminUsers />} />}
          {isAdmin && <Route path="/admin/users/:id" element={<AdminUser />} />}
          {isAdmin && <Route path="/admin/system" element={<AdminSystem />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className="alert error" role="alert">
      {e.message ?? String(error)}
      {e.requestId && <span className="muted small"> (request {e.requestId.slice(0, 8)})</span>}
    </div>
  );
}
