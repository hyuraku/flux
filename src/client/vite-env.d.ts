/// <reference types="vite/client" />

// CSS module declarations
declare module '*.css' {
  const content: { [className: string]: string };
  export default content;
}

// Environment variables
interface ImportMetaEnv {
  readonly VITE_PARTYKIT_HOST?: string;
  readonly VITE_TURN_SERVER?: string;
  readonly VITE_ENABLE_ENCRYPTION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
