import { createContext } from 'react';

// The context object lives alone (Fast Refresh allows context-only exports);
// the provider and useLanguage() hook import it from here.

export const LanguageContext = createContext({ lang: 'en', setLang: () => {}, t: (key) => key });