import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const ThemeContext = createContext(null);

export const VIBES = ['volt', 'space', 'noir'];

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => localStorage.getItem('cv-theme') || 'dark');
  const [vibe, setVibeState] = useState(() => localStorage.getItem('cv-vibe') || 'volt');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-vibe', vibe);
  }, [vibe]);

  const setTheme = useCallback((t) => {
    if (t !== 'light' && t !== 'dark') return;
    setThemeState(t);
    localStorage.setItem('cv-theme', t);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((cur) => {
      const next = cur === 'dark' ? 'light' : 'dark';
      localStorage.setItem('cv-theme', next);
      return next;
    });
  }, []);

  const setVibe = useCallback((v) => {
    if (!VIBES.includes(v)) return;
    setVibeState(v);
    localStorage.setItem('cv-vibe', v);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, vibe, setVibe }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
