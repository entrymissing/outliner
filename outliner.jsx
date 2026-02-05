import ReactDOM from 'react-dom/client';
import './index.css';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GripVertical, ChevronRight, ChevronDown, Plus, Trash2, Cloud, CloudOff, CheckCircle2, Circle, Loader2, Eye, EyeOff, X, User, Layout, Moon, Sun, RefreshCw, AlertTriangle } from 'lucide-react';
// Google OAuth + Drive integration (replaces Firebase)
// The app expects a Vite env var named VITE_GOOGLE_CLIENT_ID containing a valid
// Google OAuth Client ID for browser-based OAuth. Add this to `.env.local`.
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

// Drive file name we use as the single Source of Truth
const DRIVE_FILE_NAME = 'Outliner.md';

// Helper to check auth availability (token kept in memory - sign-in persistence via localStorage; token itself is not stored)

// Note: We rely on the Google Identity Services script loaded in `index.html`:
// <script src="https://accounts.google.com/gsi/client" async defer></script>

// Scopes: drive.file for read/write access to files created/opened by the app.
// Also request OpenID/email/profile so we can call the userinfo endpoint to show the signed-in user.
const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly openid email profile';

// Globals: token client and current access token
let tokenClient = null; // google.accounts.oauth2.TokenClient

// Utility: fetch helper that attaches current access token
const authFetch = async (url, opts = {}, accessToken) => {
  const headers = Object.assign({}, opts.headers || {}, {
    'Authorization': `Bearer ${accessToken}`,
  });
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
  return res;
};

// --- Utility Functions ---

const generateId = () => Math.random().toString(36).substr(2, 9);

const flattenTree = (nodes, depth = 0, visibleList = [], showCompleted = false) => {
  nodes.forEach(node => {
    // Filter out completed items if showCompleted is false
    // EXCEPTION: Always show top-level sections (depth 0) even if marked complete, 
    // otherwise the user loses the container entirely.
    if (!showCompleted && node.completed && depth > 0) return;

    visibleList.push({ ...node, depth });
    if (!node.collapsed && node.children && node.children.length > 0) {
      flattenTree(node.children, depth + 1, visibleList, showCompleted);
    }
  });
  return visibleList;
};

const cloneTree = (items) => JSON.parse(JSON.stringify(items));

const findNodePath = (nodes, id, path = []) => {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return [...path, { nodes, index: i, node: nodes[i] }];
    if (nodes[i].children) {
      const result = findNodePath(nodes[i].children, id, [...path, { nodes, index: i, node: nodes[i] }]);
      if (result) return result;
    }
  }
  return null;
};

// Default data now structured as Sections
const DEFAULT_TREE = [
  { id: '1', text: 'Active Projects', completed: false, collapsed: false, children: [
    { id: '2', text: 'Website Redesign', completed: false, collapsed: false, children: [] },
    { id: '3', text: 'Q4 Marketing Plan', completed: false, collapsed: false, children: [] }
  ]},
  { id: '4', text: 'Postponed Projects', completed: false, collapsed: false, children: [
      { id: '5', text: 'Mobile App v2', completed: false, collapsed: false, children: [] }
  ]}
];

export default function App() {
  // --- State ---
  const [tree, setTree] = useState(null); // Start as null to distinguish from "loaded empty data"
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [isLoaded, setIsLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState('idle'); 
  const [showCompleted, setShowCompleted] = useState(false);
  const [focusedId, setFocusedId] = useState(null);
  const [darkMode, setDarkMode] = useState(false);

  // Drive / sync refs
  const driveFileId = useRef(null);
  const lastRemoteMarkdown = useRef('');
  const pollIntervalRef = useRef(null);
  const lastInteractionRef = useRef(Date.now());
  const isStaleLockRef = useRef(false); // prevents edits until we re-fetch if stale
  
  const inputRefs = useRef({});
  const caretPosRef = useRef({});
  const pendingFocus = useRef(null);
  const saveTimeoutRef = useRef(null);
  const savingTreeRef = useRef(null);
  const lastSyncedTimestamp = useRef(null);
  const lastServerTreeStr = useRef(''); // Helps us know if our local changes are actually new
  const localVersion = useRef(0);
  const authTimeoutRef = useRef(null);

  const [draggedItem, setDraggedItem] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const visibleItems = tree ? flattenTree(tree, 0, [], showCompleted) : [];

// --- Google Auth Initialization ---
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) {
      console.warn('VITE_GOOGLE_CLIENT_ID is not set. Google sign-in will not function.');
      setAuthLoading(false);
      return;
    }

    let mounted = true;
    let intervalId = null;

    const initTokenClient = async () => {
      try {
        if (window.google && !tokenClient) {
          tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope: DRIVE_SCOPES,
            callback: async (resp) => {
              console.log('Token client callback', resp);

              if (authTimeoutRef.current) {
                clearTimeout(authTimeoutRef.current);
                authTimeoutRef.current = null;
              }

              if (resp.error) {
                console.error('Token client error', resp);
                if (mounted) setAuthLoading(false);
                // Clear persisted signed-in flag and stored email if silent or interactive sign-in failed
                try { localStorage.removeItem('outliner:signedIn'); localStorage.removeItem('outliner:email'); } catch (e) { /* ignore */ }
                alert('Google sign-in failed: ' + (resp.error_description || resp.error));
                return;
              }

              if (resp.access_token) {
                if (mounted) setAccessToken(resp.access_token);
                // Persist a lightweight signed-in flag so we can attempt silent sign-in on reloads
                try { localStorage.setItem('outliner:signedIn', 'true'); } catch (e) { /* ignore */ }
                if (mounted) setAuthLoading(false);
                // Fetch basic userinfo so we can display an email
                try {
                  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { "Authorization": `Bearer ${resp.access_token}` } });
                  if (r.ok && mounted) {
                    const userInfo = await r.json();
                    setUser(userInfo);
                    try { localStorage.setItem('outliner:email', userInfo.email || ''); } catch (e) { /* ignore */ }
                  } else {
                    const body = await r.text();
                    console.error('Userinfo fetch failed', r.status, body);
                    if (mounted) {
                      // Show a helpful alert so the user can check console and OAuth settings
                      alert('Failed to fetch user info (status: ' + r.status + '). Check OAuth scopes and browser console for details.');
                    }
                  }
                } catch (e) {
                  console.error('Error fetching userinfo', e);
                }
              } else {
                // No token was returned (unexpected)
                console.warn('Token client returned no access token:', resp);
                if (mounted) setAuthLoading(false);
              }
            }
          });
          // If initialization succeeded, stop polling
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }

          // If a previous sign-in was recorded, attempt a silent token request to restore session
          try {
            const wasSigned = localStorage.getItem('outliner:signedIn') === 'true';
            const storedEmail = localStorage.getItem('outliner:email') || undefined;
            if (wasSigned) {
              // Attempt silent token retrieval (no consent prompt). Pass login_hint to avoid account chooser when possible.
              setAuthLoading(true);
              const reqOpts = storedEmail ? { prompt: '', login_hint: storedEmail } : { prompt: '' };
              tokenClient.requestAccessToken(reqOpts);
              if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
              authTimeoutRef.current = setTimeout(() => {
                // silent sign-in did not complete
                setAuthLoading(false);
                authTimeoutRef.current = null;
              }, 7000);
            }
          } catch (e) {
            console.warn('Silent sign-in attempt failed', e);
            setAuthLoading(false);
            try { localStorage.removeItem('outliner:signedIn'); localStorage.removeItem('outliner:email'); } catch (e2) { /* ignore */ }
          }
        }
      } catch (e) {
        console.error('Auth init failed', e);
      } finally {
        if (mounted) setAuthLoading(false);
      }
    };

    // Try immediate initialization, then poll briefly if the google script hasn't loaded yet
    initTokenClient();

    if (!window.google) {
      let attempts = 0;
      intervalId = setInterval(() => {
        attempts += 1;
        initTokenClient();
        if (window.google || attempts >= 10) {
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
        }
      }, 200);

      // Safety timeout: if not initialized after ~2.5s, stop trying and warn
      setTimeout(() => {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
        if (!tokenClient) {
          console.warn('Google Identity script did not load in time; token client not initialized.');
          if (mounted) setAuthLoading(false);
        }
      }, 2500);
    }

    return () => {
      mounted = false;
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  // --- Login Handler ---
  const handleLogin = async () => {
    if (!tokenClient) {
      alert('Google auth client not initialized. Ensure `VITE_GOOGLE_CLIENT_ID` is set and the Google Identity script is loaded.');
      return;
    }

    setAuthLoading(true);
    try {
      console.log('Requesting access token...');
      tokenClient.requestAccessToken({ prompt: 'consent' });

      // Set a short timeout to detect when no token is returned (helps diagnose misconfig or origin issues)
      if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
      authTimeoutRef.current = setTimeout(() => {
        console.warn('No access token received after login attempt. Check OAuth client settings (Authorized JavaScript origins) and the browser console for errors.');
        setAuthLoading(false);
        alert('Sign in did not complete. Check the browser console for details.');
        authTimeoutRef.current = null;
      }, 7000);
    } catch (err) {
      console.error('Login failed', err);
      alert(err.message || 'Login failed');
      setAuthLoading(false);
    }
  };

  // --- Logout Handler ---
  const handleLogout = async () => {
    try {
      if (accessToken) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${accessToken}`, { method: 'POST', headers: { 'Content-type': 'application/x-www-form-urlencoded' } });
      }
    } catch (e) {
      console.warn('Failed to revoke token', e);
    }

    setTree(null);
    setIsLoaded(false);
    setUser(null);
    setAccessToken(null);
    driveFileId.current = null;
    lastRemoteMarkdown.current = '';
    try { localStorage.removeItem('outliner:signedIn'); localStorage.removeItem('outliner:email'); } catch (e) { /* ignore */ }
  };
  
  // --- Drive Sync (Load + Poll) ---
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    const findOrCreateAndLoad = async () => {
      try {
        // 1) Search for the file
        const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
        const listRes = await authFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime,size)&pageSize=10`, {}, accessToken);
        const listData = await listRes.json();

        let fileId = null;
        if (listData.files && listData.files.length > 0) {
          fileId = listData.files[0].id;
          // If file exists, fetch its content
          const contentRes = await authFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {}, accessToken);
          const mdText = await contentRes.text();
          lastRemoteMarkdown.current = mdText;
          const parsed = markdownToTree(mdText);
          setTree(parsed);
          setIsLoaded(true);
          lastSyncedTimestamp.current = new Date(listData.files[0].modifiedTime).getTime();
        } else {
          // Create an empty file with default content
          const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'text/markdown' })
          });
          const created = await createRes.json();
          fileId = created.id;
          const md = treeToMarkdown(DEFAULT_TREE);
          await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'text/markdown' },
            body: md
          });
          lastRemoteMarkdown.current = md;
          setTree(DEFAULT_TREE);
          setIsLoaded(true);
          lastSyncedTimestamp.current = Date.now();
        }

        driveFileId.current = fileId;
        setSaveStatus('saved');
      } catch (e) {
        console.error('Error loading Drive file:', e);
        setSaveStatus('error');
      }
    };

    findOrCreateAndLoad();

    // 2) Poll for changes every 15 minutes
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(async () => {
      try {
        if (!driveFileId.current) return;
        const infoRes = await authFetch(`https://www.googleapis.com/drive/v3/files/${driveFileId.current}?fields=modifiedTime`, {}, accessToken);
        const info = await infoRes.json();
        const remoteModified = new Date(info.modifiedTime).getTime();
        if (!lastSyncedTimestamp.current || remoteModified > lastSyncedTimestamp.current) {
          // remote changed, fetch content
          const remoteRes = await authFetch(`https://www.googleapis.com/drive/v3/files/${driveFileId.current}?alt=media`, {}, accessToken);
          const md = await remoteRes.text();
          if (md !== lastRemoteMarkdown.current) {
            lastRemoteMarkdown.current = md;
            setTree(markdownToTree(md));
            lastSyncedTimestamp.current = remoteModified;
            setSaveStatus('saved');
          }
        }
      } catch (e) {
        console.error('Polling error', e);
      }
    }, 15 * 60 * 1000);

    return () => {
      cancelled = true;
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [accessToken]);

  // --- Drive Sync (Save) ---
  useEffect(() => {
    if (!accessToken || !isLoaded || tree === null) return;

    // Prevent saving an empty local state over a non-empty remote file
    const localMd = treeToMarkdown(tree);
    if (localMd.trim() === '' && lastRemoteMarkdown.current && lastRemoteMarkdown.current.trim() !== '') {
      // Abort save and surface an error state
      setSaveStatus('error');
      console.warn('Prevented overwriting non-empty remote file with empty local state');
      return;
    }

    // No-op if same as what we last loaded
    if (localMd === lastRemoteMarkdown.current) return;

    setSaveStatus('saving');
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        if (!driveFileId.current) throw new Error('No Drive file id');

        await fetch(`https://www.googleapis.com/upload/drive/v3/files/${driveFileId.current}?uploadType=media`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'text/markdown' },
          body: localMd
        });

        lastRemoteMarkdown.current = localMd;
        lastSyncedTimestamp.current = Date.now();
        setSaveStatus('saved');
      } catch (err) {
        console.error('Error saving to Drive:', err);
        setSaveStatus('error');
      }
    }, 1000);

    return () => clearTimeout(saveTimeoutRef.current);
  }, [tree, accessToken, isLoaded]);

  // --- Focus Restoration ---
  useEffect(() => {
    if (pendingFocus.current && inputRefs.current[pendingFocus.current]) {
      inputRefs.current[pendingFocus.current].focus();
      pendingFocus.current = null;
    }
  }, [visibleItems, focusedId]);

  // Restore caret position when focused input re-renders (e.g. on save status changes)
  useEffect(() => {
    if (!focusedId) return;
    const el = inputRefs.current[focusedId];
    const pos = caretPosRef.current[focusedId];
    if (el && pos) {
      try {
        el.setSelectionRange(pos.start, pos.end);
      } catch (e) {
        // ignore
      }
      caretPosRef.current[focusedId] = null;
    }
  }, [tree, focusedId, saveStatus]);

  // --- Theme Persistence: initialize from localStorage or system preference ---
  const getInitialDarkMode = () => {
    try {
      const stored = localStorage.getItem('outliner:darkMode');
      if (stored !== null) return stored === 'true';
      // Fallback to user's system preference if nothing stored
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {
      return false;
    }
  };

  // Track user activity for inactivity checks
  useEffect(() => {
    const touch = () => { lastInteractionRef.current = Date.now(); };
    window.addEventListener('click', touch);
    window.addEventListener('keydown', touch);
    return () => {
      window.removeEventListener('click', touch);
      window.removeEventListener('keydown', touch);
    };
  }, []);

  // Replace default initializer with the computed value (lazy initializer)
  useEffect(() => {
    try {
      const initial = getInitialDarkMode();
      setDarkMode(initial);
    } catch (e) {
      /* ignore */
    }
    // run only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist theme changes to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('outliner:darkMode', darkMode ? 'true' : 'false');
    } catch (e) {
      // ignore quota / privacy errors
    }
  }, [darkMode]);

  const parseTextToLinks = (text) => {
    if (!text) return <span className="opacity-0">Empty</span>;

    const regex = /((?:https?:\/\/[^\s]+)|(?:\bb\/\d+)|(?:\bgo\/[^\s]+))/g;
    const parts = text.split(regex);

    return parts.map((part, index) => {
      if (part.match(/^https?:\/\//)) {
        return (
          <a key={index} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer relative z-20" onClick={(e) => e.stopPropagation()}>{part}</a>
        );
      }
      if (part.match(/^b\/\d+$/)) {
        return (
          <a key={index} href={`http://${part}`} target="_blank" rel="noopener noreferrer" className="text-amber-600 dark:text-amber-400 hover:underline cursor-pointer font-mono relative z-20" onClick={(e) => e.stopPropagation()}>{part}</a>
        );
      }
      if (part.match(/^go\//)) {
        return (
          <a key={index} href={`http://${part}`} target="_blank" rel="noopener noreferrer" className="text-emerald-600 dark:text-emerald-400 hover:underline font-medium relative z-20" onClick={(e) => e.stopPropagation()}>{part}</a>
        );
      }
      return <span key={index}>{part}</span>;
    });
  };

  // --- Markdown Parser / Serializer ---

  // Converts a markdown string into the app's tree structure and back.
  const markdownToTree = (md) => {
    const lines = (md || '').split('\n');
    const sections = [];
    let currentSection = null;
    let currentProject = null;

    const headerRE = /^#\s+(.*)$/;
    const bulletRE = /^\s*[-*]\s+(.*)$/;
    const nestedBulletRE = /^\s{2,}[-*]\s+(.*)$/; // first nested level

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      const h = line.match(headerRE);
      if (h) {
        currentSection = { id: generateId(), text: h[1].trim(), completed: false, collapsed: false, children: [] };
        sections.push(currentSection);
        currentProject = null;
        continue;
      }

      const nb = line.match(nestedBulletRE);
      if (nb && currentProject) {
        // nested bullet: treat first nested bullet as metadata (links), subsequent as status notes
        const child = { id: generateId(), text: nb[1].trim(), completed: false, collapsed: false, children: [] };
        currentProject.children = currentProject.children || [];
        currentProject.children.push(child);
        continue;
      }

      const b = line.match(bulletRE);
      if (b && currentSection) {
        // top-level project under current section
        currentProject = { id: generateId(), text: b[1].trim(), completed: false, collapsed: false, children: [] };
        currentSection.children.push(currentProject);
        continue;
      }

      // ignore other lines
    }

    // If the file had no sections, provide a default
    if (sections.length === 0) return cloneTree(DEFAULT_TREE);
    return sections;
  };

  const normalizeTreeForSave = (tree) => {
    const copy = cloneTree(tree);
    // Flatten deeper-than-allowed nesting: we only allow Section -> Projects -> Status/Metadata bullets
    const normalized = copy.map(section => {
      if (!section.children) return section;
      section.children = section.children.map(project => {
        // collect any nested grandchildren into this project's children as status notes
        const newChildren = [];
        if (project.children && project.children.length > 0) {
          const queue = [...project.children];
          while (queue.length > 0) {
            const c = queue.shift();
            newChildren.push({ id: generateId(), text: c.text, completed: !!c.completed, children: [] });
            if (c.children && c.children.length > 0) {
              // append grandchildren to queue (flatten)
              for (const gg of c.children) queue.push(gg);
            }
          }
        }
        project.children = newChildren;
        return project;
      });
      return section;
    });
    return normalized;
  };

  const treeToMarkdown = (tree) => {
    const normalized = normalizeTreeForSave(tree);
    let out = '';
    for (const section of normalized) {
      out += `# ${section.text || ''}\n\n`;
      if (section.children && section.children.length > 0) {
        for (const project of section.children) {
          out += `- ${project.text || ''}\n`;
          if (project.children && project.children.length > 0) {
            for (const child of project.children) {
              out += `  - ${child.text || ''}\n`;
            }
          }
        }
      }
      out += '\n';
    }
    return out.trim() + '\n';
  };

  // --- Actions ---

  const ensureFreshBeforeEdit = async () => {
    // If user was inactive for > 60 minutes, re-fetch remote and apply before allowing edits
    if (!accessToken || !driveFileId.current) return true; // unable to check

    if (isStaleLockRef.current) return false;
    isStaleLockRef.current = true;
    try {
      const res = await authFetch(`https://www.googleapis.com/drive/v3/files/${driveFileId.current}?alt=media`, {}, accessToken);
      const md = await res.text();
      if (md !== lastRemoteMarkdown.current) {
        lastRemoteMarkdown.current = md;
        setTree(markdownToTree(md));
      }
      lastSyncedTimestamp.current = Date.now();
      return true;
    } catch (e) {
      console.error('Failed to refresh before edit', e);
      return false;
    } finally {
      isStaleLockRef.current = false;
    }
  };

  /**
   * Helper to wrap any state-modifying action with a freshness check.
   * If the data is stale (no interaction for 60m), it syncs with Drive before proceeding.
   */
  const performAction = async (action, ...args) => {
    const now = Date.now();
    const wasStale = (now - lastInteractionRef.current >= (60 * 60 * 1000));
    lastInteractionRef.current = now;

    if (wasStale) {
      const ok = await ensureFreshBeforeEdit();
      if (!ok) return;
    }

    return action(...args);
  };

  const updateText = (id, newText) => {
    // We don't use performAction here to keep text updates synchronous
    // and prevent cursor jumping. We assume freshness was checked on focus.
    lastInteractionRef.current = Date.now();

    // Preserve caret position for this input so re-renders (e.g. save status) won't move it to the end
    try {
      const el = inputRefs.current[id];
      if (el && typeof el.selectionStart === 'number') {
        caretPosRef.current[id] = { start: el.selectionStart, end: el.selectionEnd };
      }
    } catch (e) {
      // ignore
    }

    const newTree = cloneTree(tree);
    const path = findNodePath(newTree, id);
    if (path) {
      path[path.length - 1].nodes[path[path.length - 1].index].text = newText;
      setTree(newTree);
      localVersion.current++;
    }
  };

  const toggleCollapse = (id) => performAction(() => {
    const newTree = cloneTree(tree);
    const path = findNodePath(newTree, id);
    if (path) {
      const node = path[path.length - 1].node;
      node.collapsed = !node.collapsed;
      setTree(newTree);
      localVersion.current++;
    }
  });

  const toggleComplete = (id) => performAction(() => {
    const newTree = cloneTree(tree);
    const path = findNodePath(newTree, id);
    if (path) {
      const { node } = path[path.length - 1];
      const newStatus = !node.completed;
      node.completed = newStatus;
      
      if (newStatus && node.children) {
          const markChildren = (children) => {
              children.forEach(child => {
                  child.completed = true;
                  if (child.children) markChildren(child.children);
              });
          }
          markChildren(node.children);
      }
      setTree(newTree);
      localVersion.current++;
    }
  });

  const addNode = (afterId, isSection = false) => performAction(() => {
    const newTree = cloneTree(tree);
    const newNode = { id: generateId(), text: '', completed: false, collapsed: false, children: [] };
    
    const path = findNodePath(newTree, afterId);
    if (path) {
      const { nodes, index } = path[path.length - 1];
      nodes.splice(index + 1, 0, newNode);
      setTree(newTree);
      localVersion.current++;
      // Ensure the new node becomes the focused edit target and we request focus
      setFocusedId(newNode.id);
      pendingFocus.current = newNode.id;
    }
  });

  // Used only for empty state recovery
  const addRootNode = () => performAction(() => {
      const newTree = cloneTree(tree);
      const newSectionId = generateId();
      
      const newSection = {
          id: newSectionId,
          text: '', 
          completed: false,
          collapsed: false,
          children: []
      };
      
      newTree.push(newSection);
        setTree(newTree);
        localVersion.current++;
        // Put the new root section into edit mode and request focus
        setFocusedId(newSectionId);
        pendingFocus.current = newSectionId;
  });

  const deleteNode = (id) => performAction(() => {
    const currentIndex = visibleItems.findIndex(item => item.id === id);
    let nextFocusId = null;
    if (currentIndex > 0) nextFocusId = visibleItems[currentIndex - 1].id;
    else if (currentIndex < visibleItems.length - 1) nextFocusId = visibleItems[currentIndex + 1].id;

    const newTree = cloneTree(tree);
    const path = findNodePath(newTree, id);
    if (path) {
      const { nodes, index } = path[path.length - 1];
      nodes.splice(index, 1);
      setTree(newTree);
      localVersion.current++;
      if (nextFocusId) {
        // make sure the next item is focused after deletion
        setFocusedId(nextFocusId);
        pendingFocus.current = nextFocusId;
      } else {
        // If there is nothing to focus, clear the focusedId
        setFocusedId(null);
      }
    }
  });

  const indentNode = (id) => performAction(() => {
    const newTree = cloneTree(tree);
    const path = findNodePath(newTree, id);
    if (!path) return;

    const { nodes, index } = path[path.length - 1];
    if (index === 0) return; // Can't indent first item

    const prevSibling = nodes[index - 1];
    const nodeToMove = nodes[index];

    nodes.splice(index, 1);
    if (!prevSibling.children) prevSibling.children = [];
    prevSibling.children.push(nodeToMove);
    prevSibling.collapsed = false;

    setTree(newTree);
    localVersion.current++;
    // Keep edit focus on the moved item
    setFocusedId(id);
    pendingFocus.current = id;
  });

  const outdentNode = (id) => performAction(() => {
    const newTree = cloneTree(tree);
    const path = findNodePath(newTree, id);
    if (!path || path.length < 2) return;

    const currentLevel = path[path.length - 1];
    const parentLevel = path[path.length - 2];

    const nodeToMove = currentLevel.nodes[currentLevel.index];
    currentLevel.nodes.splice(currentLevel.index, 1);
    parentLevel.nodes.splice(parentLevel.index + 1, 0, nodeToMove);

    setTree(newTree);
    localVersion.current++;
    // Keep edit focus on the moved item
    setFocusedId(id);
    pendingFocus.current = id;
  });

  const moveNode = (draggedId, targetId, position) => performAction(() => {
    if (draggedId === targetId) return;
    const newTree = cloneTree(tree);
    
    const dragPath = findNodePath(newTree, draggedId);
    if (!dragPath) return;
    const dragInfo = dragPath[dragPath.length - 1];
    const nodeToMove = dragInfo.nodes.splice(dragInfo.index, 1)[0];

    const targetPath = findNodePath(newTree, targetId);
    if (!targetPath) return;
    const targetInfo = targetPath[targetPath.length - 1];
    
    if (position === 'inside') {
      targetInfo.node.children.unshift(nodeToMove);
      targetInfo.node.collapsed = false;
    } else if (position === 'after') {
      targetInfo.nodes.splice(targetInfo.index + 1, 0, nodeToMove);
    } else if (position === 'before') {
      targetInfo.nodes.splice(targetInfo.index, 0, nodeToMove);
    }

    setTree(newTree);
    localVersion.current++;
  });

  // --- Event Handlers ---

  const handleKeyDown = (e, id, text, depth) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addNode(id);
    } else if (e.key === 'Backspace' && text === '') {
      e.preventDefault();
      deleteNode(id);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) outdentNode(id);
      else indentNode(id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const index = visibleItems.findIndex(item => item.id === id);
      if (index > 0) {
        const prevId = visibleItems[index - 1].id;
        performAction(() => {
          setFocusedId(prevId);
          pendingFocus.current = prevId;
        });
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const index = visibleItems.findIndex(item => item.id === id);
      if (index < visibleItems.length - 1) {
        const nextId = visibleItems[index + 1].id;
        performAction(() => {
          setFocusedId(nextId);
          pendingFocus.current = nextId;
        });
      }
    }
  };

  const handleDragStart = (e, item) => {
    setDraggedItem(item);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, targetItem) => {
    e.preventDefault();
    if (!draggedItem || draggedItem.id === targetItem.id) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    
    let position = 'inside';
    // Easier to target before/after on sections (larger targets)
    const zone = targetItem.depth === 0 ? 0.3 : 0.25;
    
    if (offsetY < rect.height * zone) position = 'before';
    else if (offsetY > rect.height * (1 - zone)) position = 'after';

    setDropTarget({ id: targetItem.id, position });
  };

  const handleDrop = (e) => {
    e.preventDefault();
    if (draggedItem && dropTarget) {
      moveNode(draggedItem.id, dropTarget.id, dropTarget.position);
    }
    setDraggedItem(null);
    setDropTarget(null);
  };

  // --- RENDER: 1. Auth Loading ---
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="animate-spin text-blue-500" />
      </div>
    );
  }

  // --- RENDER: 2. Login Screen (Gatekeeper) ---
  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-4">
        <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-100 max-w-sm w-full text-center">
          <div className="mb-6 bg-blue-100 p-3 rounded-full w-fit mx-auto text-blue-600">
            <Layout size={32} />
          </div>
          <h1 className="text-2xl font-bold text-gray-800 mb-2">Outliner</h1>
          <p className="text-gray-500 mb-8">Sign in to access your notes.</p>
          
          <button 
            onClick={handleLogin}
            className="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-lg transition-colors"
          >
             {/* You can use a Google Icon here if you want, or just text */}
             <span>Sign in with Google</span>
          </button>
        </div>
      </div>
    );
  }
  
  if (!isLoaded) {
      return (
          <div className="min-h-screen flex items-center justify-center bg-white text-gray-500">
              <div className="flex items-center gap-2">
                  <Loader2 className="animate-spin" /> Loading...
              </div>
          </div>
      );
  }

  return (
    <div className={`min-h-screen transition-colors duration-300 ${darkMode ? 'dark bg-slate-900 text-slate-100' : 'bg-gray-50 text-gray-800'} font-sans p-8`}>
      <div className={`max-w-4xl mx-auto relative min-h-[80vh] shadow-sm rounded-xl p-8 border transition-colors ${darkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-gray-100'}`}>
        
        {/* Header area */}
        <div className={`flex items-center justify-end mb-6 border-b pb-4 ${darkMode ? 'border-slate-700' : 'border-gray-100'}`}>
            
          <div className="flex items-center gap-6">
            <button 
              onClick={() => setDarkMode(!darkMode)}
              className={`p-1.5 rounded-full transition-colors ${darkMode ? 'text-yellow-400 hover:bg-slate-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
              title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>

            <button 
              onClick={() => setShowCompleted(!showCompleted)}
              className={`flex items-center gap-2 text-sm font-medium transition-colors ${darkMode ? 'text-slate-400 hover:text-slate-200' : 'text-gray-500 hover:text-gray-800'}`}
            >
              {showCompleted ? <Eye size={16} /> : <EyeOff size={16} />}
              {showCompleted ? 'Hide Done' : 'Show Done'}
            </button>

            <div className={`flex items-center gap-2 text-sm font-medium justify-end min-w-[80px] ${darkMode ? 'text-slate-500' : 'text-gray-400'}`}>
              {saveStatus === 'saving' && <><Loader2 size={14} className="animate-spin text-blue-500" /> Saving</>}
              {saveStatus === 'saved' && <><CheckCircle2 size={14} className="text-green-500" /> <span className="text-green-600">Saved</span></>}
              {saveStatus === 'error' && <><CloudOff size={14} className="text-red-500" /> Offline</>}
              {saveStatus === 'conflict' && <><RefreshCw size={14} className="text-amber-500 animate-spin" /> <span className="text-amber-500">Syncing...</span></>}
            </div>
          </div>
        </div>
        
        <div className="space-y-0.5 pb-40">
          {visibleItems.map((item) => {
            const isSection = item.depth === 0;
            const isDragging = draggedItem?.id === item.id;
            const isDropTarget = dropTarget?.id === item.id;
            
            return (
              <div 
                key={item.id}
                className={`
                  relative group flex items-start transition-all duration-100 pr-4
                  ${isDragging ? 'opacity-30' : 'opacity-100'}
                  ${isSection ? 'mt-6 mb-2' : ''} 
                `}
                style={{ paddingLeft: isSection ? '0px' : `${item.depth * 24}px` }}
                onDragOver={(e) => handleDragOver(e, item)}
                onDrop={handleDrop}
              >
                {/* Drop Indicators */}
                {isDropTarget && dropTarget.position === 'before' && (
                  <div className="absolute top-0 left-0 right-0 h-0.5 bg-blue-500 z-10" />
                )}
                {isDropTarget && dropTarget.position === 'after' && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 z-10" />
                )}
                
                <div className="flex items-center h-7 self-start mt-0.5 pr-2">
                    {/* Draggable Handle */}
                    <div
                        className="w-6 h-full flex items-center justify-center cursor-move opacity-0 group-hover:opacity-30 hover:!opacity-100 transition-opacity"
                        draggable
                        onDragStart={(e) => handleDragStart(e, item)}
                    >
                        <GripVertical size={16} />
                    </div>

                    {/* Collapse Toggle or Spacer */}
                    <div className="w-6 h-full flex items-center justify-center">
                        {item.children && item.children.length > 0 ? (
                            <button
                                onClick={() => toggleCollapse(item.id)}
                                className="text-gray-400 hover:text-gray-600 p-1 rounded-sm"
                                tabIndex={-1}
                            >
                                {item.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            </button>
                        ) : (
                           // Spacer for non-section items to align checkboxes
                           !isSection && <div className="w-6" />
                        )}
                    </div>

                    {/* Checkbox or Section Icon */}
                    <div className="w-6 h-full flex items-center justify-center">
                       {isSection ? (
                           <div className="text-gray-300">
                                <Layout size={16} />
                           </div>
                       ) : (
                            <button
                                onClick={() => toggleComplete(item.id)}
                                className={`
                                    p-0.5 rounded hover:bg-gray-100 transition-colors
                                    ${item.completed ? 'text-green-500' : 'text-gray-300 hover:text-gray-400'}
                                `}
                                tabIndex={-1}
                            >
                                {item.completed ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                            </button>
                       )}
                    </div>
                </div>

                {/* Content Area: Switches between Input (Edit) and Div (View/SmartLink) */}
                <div className={`relative flex-1 ${isSection ? `border-b pb-1 ${darkMode ? 'border-slate-700' : 'border-gray-200'}` : ''}`}>
                  {focusedId === item.id ? (
                    <input
                      ref={(el) => {
                        inputRefs.current[item.id] = el;
                      }}
                      value={item.text}
                      onChange={(e) => updateText(item.id, e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, item.id, item.text, item.depth)}
                      className={`
                        w-full bg-transparent outline-none transition-all
                        ${isSection 
                          ? `text-xl font-bold ${darkMode ? 'text-slate-100 placeholder-slate-600' : 'text-gray-800 placeholder-gray-300'}` 
                          : `leading-relaxed ${item.completed 
                            ? (darkMode ? 'line-through text-slate-600' : 'line-through text-gray-400') 
                            : (darkMode ? 'text-slate-200' : 'text-gray-700')}`
                        }
                      `}
                      placeholder={isSection ? "Section Name" : "Type a task..."}
                    />
                  ) : (
                    <div 
                      onClick={() => performAction(() => {
                        setFocusedId(item.id);
                        pendingFocus.current = item.id;
                      })}
                      className={`
                        w-full min-h-[1.5em] cursor-text
                        ${isSection 
                          ? `text-xl font-bold ${darkMode ? 'text-slate-100' : 'text-gray-800'}` 
                          : `leading-relaxed ${item.completed 
                            ? (darkMode ? 'line-through text-slate-600' : 'line-through text-gray-400') 
                            : (darkMode ? 'text-slate-200' : 'text-gray-700')}`
                        }
                      `}
                    >
                      <div className="flex items-center justify-between">
                        <div>{parseTextToLinks(item.text)}</div>

                        {/* Metadata Links: first nested child that contains URLs (Notes Doc / Tracking bug) */}
                        {item.depth === 1 && item.children && item.children.length > 0 && (() => {
                          const meta = item.children[0].text || '';
                          const urlRE = /(https?:\/\/[^\s]+)/g;
                          const matches = meta.match(urlRE) || [];
                          if (matches.length === 0) return null;
                          return (
                            <div className="flex items-center gap-2 ml-4">
                              {matches.map((u, i) => (
                                <a key={i} href={u} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 dark:text-blue-400 hover:underline ml-2" onClick={(e) => e.stopPropagation()}>
                                  {u.replace(/^https?:\/\//, '')}
                                </a>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </div>

                {/* Delete Action */}
                <button 
                    onClick={() => deleteNode(item.id)}
                    className={`
                        opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-opacity px-2
                        ${isSection ? 'mt-1' : ''}
                    `}
                    title={isSection ? "Delete Section & Contents" : "Delete item"}
                    tabIndex={-1}
                >
                    <Trash2 size={14} />
                </button>
              </div>
            );
          })}

          {visibleItems.length === 0 && (
             <div 
                onClick={addRootNode}
                className="text-center py-20 text-gray-400 italic cursor-pointer hover:text-gray-600 hover:bg-gray-50 rounded-lg border-2 border-dashed border-transparent hover:border-gray-200 transition-all"
             >
                 Empty board. Click here to add your first section.
             </div>
          )}
        </div>
        
      </div>
      
      {/* Help Footer */}
      <div className="fixed bottom-4 right-4 bg-white p-4 rounded-lg text-xs text-gray-500 border border-gray-200 shadow-sm flex items-center gap-4">
        <div className="h-full w-px bg-gray-200 mx-1"></div>
        <div className="flex flex-col items-end gap-1">
              <span className="font-medium text-gray-700">{user.email}</span>
              <button 
                onClick={handleLogout} 
                className="text-red-500 hover:text-red-600 hover:underline"
              >
                Sign Out
              </button>
           </div>
      </div>
    </div>
  );
}

// Mount the app to the DOM
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);