import { initializeApp, type FirebaseApp } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";

export interface FirebasePublicConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
}

function readFirebaseConfig(): FirebasePublicConfig | null {
  const env = import.meta.env;
  const apiKey = (env.VITE_FIREBASE_API_KEY ?? "").trim();
  const projectId = (env.VITE_FIREBASE_PROJECT_ID ?? "").trim();
  const appId = (env.VITE_FIREBASE_APP_ID ?? "").trim();

  if (!apiKey || !projectId || !appId) return null;

  return {
    apiKey,
    authDomain: (env.VITE_FIREBASE_AUTH_DOMAIN ?? "").trim(),
    projectId,
    storageBucket: (env.VITE_FIREBASE_STORAGE_BUCKET ?? "").trim(),
    messagingSenderId: (env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "").trim(),
    appId,
    measurementId: (env.VITE_FIREBASE_MEASUREMENT_ID ?? "").trim() || undefined,
  };
}

let app: FirebaseApp | null = null;
let db: Firestore | null = null;

export function isFirebaseConfigured(): boolean {
  return readFirebaseConfig() !== null;
}

export function getFirestoreDb(): Firestore {
  if (db) return db;
  const config = readFirebaseConfig();
  if (!config) {
    throw new Error("Firebase is not configured. Add VITE_FIREBASE_* values to .env.");
  }
  app ??= initializeApp(config);
  db = getFirestore(app);
  return db;
}
