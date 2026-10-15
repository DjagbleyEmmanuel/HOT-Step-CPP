// AuthContext.tsx — Minimal auth context for single-user local app
//
// Auto-logs in on mount, provides user + token to all children.

import React, { createContext, useContext, useEffect, useState } from 'react';
import { authApi } from '../services/api';
import { queryClient } from '../queries/client';
import { getSessionEpoch, startAuthSession } from '../queries/keys';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  token: string | null;
  /** Opaque counter that changes with the token. Auth-scoped query keys carry
   *  it (queries/keys.ts); reading it here re-renders consumers on change. */
  sessionEpoch: number;
  isAuthenticated: boolean;
  isLoading: boolean;
  updateUsername: (name: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  token: null,
  sessionEpoch: 0,
  isAuthenticated: false,
  isLoading: true,
  updateUsername: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [sessionEpoch, setSessionEpoch] = useState(getSessionEpoch);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    authApi.autoLogin()
      .then(({ user, token }) => {
        // Before the token reaches any consumer, so no render pairs the new
        // token with the old session's keys.
        setSessionEpoch(startAuthSession(queryClient, token));
        setUser(user);
        setToken(token);
      })
      .catch(err => console.error('[Auth] Auto-login failed:', err))
      .finally(() => setIsLoading(false));
  }, []);

  const updateUsername = async (name: string) => {
    if (!token) return;
    const { user: updated } = await authApi.updateUsername(name, token);
    if (updated) setUser(updated);
  };

  return (
    <AuthContext.Provider value={{ user, token, sessionEpoch, isAuthenticated: !!token, isLoading, updateUsername }}>
      {children}
    </AuthContext.Provider>
  );
};
