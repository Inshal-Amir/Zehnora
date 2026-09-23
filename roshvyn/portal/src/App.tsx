import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
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

  if (loading) return <div className="center muted">Loading…</div>;

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

function Shell() {
  const { me, setMe } = useSession();
  const navigate = useNavigate();
  const logout = async () => {
    try { await api.post('/auth/logout'); } finally { setMe(null); navigate('/'); }
  };
  const isAdmin = me?.user.role === 'admin';
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">{brand.productName}<span>Console</span></div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/keys">API keys</NavLink>
          <NavLink to="/models">Models</NavLink>
          <NavLink to="/playground">Playground</NavLink>
          <NavLink to="/docs">Quickstart</NavLink>
          {isAdmin && <div className="nav-group">Admin</div>}
          {isAdmin && <NavLink to="/admin/users">Users &amp; credits</NavLink>}
          {isAdmin && <NavLink to="/admin/system">Models &amp; requests</NavLink>}
        </nav>
        <div className="sidebar-foot">
          {me?.profile !== 'gpu' && <div className="badge warn" title="This deployment does not use the GPU model">profile: {me?.profile}</div>}
          <div className="muted small">{me?.user.email}</div>
          <button className="link" onClick={logout}>Log out</button>
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
