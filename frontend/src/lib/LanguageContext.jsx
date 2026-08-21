import { useCallback, useMemo, useState } from 'react';
import { LANG_KEY, loadLang, translate } from './i18n';
import { LanguageContext } from './language-context';

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(loadLang);

  const setLang = useCallback((next) => {
    if (!next || next === lang) return;
    localStorage.setItem(LANG_KEY, next);
    setLangState(next);
  }, [lang]);

  const value = useMemo(() => ({ lang, setLang, t: (key, vars) => translate(lang, key, vars) }), [lang, setLang]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}