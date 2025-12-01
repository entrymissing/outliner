import ReactDOM from 'react-dom/client';
import './index.css';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GripVertical, ChevronRight, ChevronDown, Plus, Trash2, Cloud, CloudOff, CheckCircle2, Circle, Loader2, Eye, EyeOff, X, User, Layout, Moon, Sun, RefreshCw, AlertTriangle } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithPopup, signOut, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, collection, runTransaction, serverTimestamp } from 'firebase/firestore';

// --- Firebase Configuration & Initialization ---
// Values are injected at build time via Vite environment variables (VITE_ prefixed).
// For local development create a `.env.local` with the same VITE_* keys.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

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
  const [tree, setTree] = useState([]); 
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [isLoaded, setIsLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState('idle'); 
  const [showCompleted, setShowCompleted] = useState(false);
  const [focusedId, setFocusedId] = useState(null);
  const [darkMode, setDarkMode] = useState(false);
  
  const inputRefs = useRef({});
  const pendingFocus = useRef(null);
  const saveTimeoutRef = useRef(null);
  const savingTreeRef = useRef(null);
  const lastSyncedTimestamp = useRef(null);
  const lastServerTreeStr = useRef(''); // Helps us know if our local changes are actually new

  const [draggedItem, setDraggedItem] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const visibleItems = flattenTree(tree, 0, [], showCompleted);

// --- Auth Effect (Changed) ---
  useEffect(() => {
    // We no longer call signInAnonymously here.
    // We just listen for the user status.
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false); // Stop loading once Firebase tells us who the user is
    });
    return () => unsubscribe();
  }, []);

  // --- Login Handler ---
  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed", error);
      alert(error.message);
    }
  };

  // --- Logout Handler ---
  const handleLogout = async () => {
    setTree([]); // Clear local state so next user doesn't see flash of old data
    setIsLoaded(false);
    await signOut(auth);
  };
  
  // --- Sync (Load) ---
  useEffect(() => {
    if (!user) return;
    const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'data', 'workflowy');
    
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        // 1. Update timestamp
        if (data.updatedAt) {
            lastSyncedTimestamp.current = data.updatedAt;
        }

        // 2. Update stringified ref so we know this is the latest server state
        const incomingTreeStr = JSON.stringify(data.tree || []);

        // RACE CONDITION SHIELD:
        // If a save is in progress and the incoming data is the same as what we're saving,
        // it's just our own save echoing back. We must not overwrite the local state,
        // as the user may have made new edits while the save was in-flight.
        if (savingTreeRef.current && incomingTreeStr === savingTreeRef.current) {
            lastServerTreeStr.current = incomingTreeStr; // Acknowledge the new baseline
            return; // Halt: Do not overwrite local state
        }
        
        // Only update local state if it's materially different from what we last saw from server
        // We compare against the ref because `tree` state in this closure might be stale
        if (incomingTreeStr !== lastServerTreeStr.current) {
            setTree(data.tree || []);
        }

        lastServerTreeStr.current = incomingTreeStr;
        setIsLoaded(true);
      } else {
        setTree(DEFAULT_TREE);
        // Initial create
        setDoc(docRef, { tree: DEFAULT_TREE, updatedAt: serverTimestamp() });
        setIsLoaded(true);
      }
    }, (error) => {
      console.error("Error fetching:", error);
      setSaveStatus('error');
    });
    return () => unsubscribe();
  }, [user]); 

  // --- Sync (Save) ---
  useEffect(() => {
    if (!user || !isLoaded) return;
    // Prevent saving empty state over existing data on initial glitch
    if (tree.length === 0 && isLoaded) return;

    // LOOP PREVENTION:
    // If the current tree is identical to the last thing the server sent us, 
    // do not trigger a save. This breaks the "Save -> Snapshot -> Save" loop.
    if (JSON.stringify(tree) === lastServerTreeStr.current) {
        return;
    }

    setSaveStatus('saving');
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(async () => {
      // --- RACE CONDITION PREVENTION ---
      // At the moment of saving, we record exactly what we're about to save.
      const treeToSave = cloneTree(tree);
      savingTreeRef.current = JSON.stringify(treeToSave);
      // ---------------------------------
      
      try {
        const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'data', 'workflowy');
        
        await runTransaction(db, async (transaction) => {
            const sfDoc = await transaction.get(docRef);
            
            if (!sfDoc.exists()) {
                transaction.set(docRef, { tree: treeToSave, updatedAt: serverTimestamp() });
                return;
            }

            const serverData = sfDoc.data();
            const serverTime = serverData.updatedAt;
            const localBaseTime = lastSyncedTimestamp.current;

            // OPTIMISTIC LOCK CHECK:
            // If server has a newer timestamp than what we last loaded, abort.
            if (serverTime && localBaseTime && 
                serverTime.toMillis() > localBaseTime.toMillis()) {
                throw new Error("Conflict: Stale Data");
            }

            transaction.set(docRef, { tree: treeToSave, updatedAt: serverTimestamp() });
        });

        setSaveStatus('saved');
      } catch (err) {
        if (err.message === "Conflict: Stale Data") {
            console.warn("Stale data detected. Aborting save to fetch latest.");
            setSaveStatus('conflict');
            // The onSnapshot listener will handle pulling the new data
        } else {
            console.error("Error saving:", err);
            setSaveStatus('error');
        }
      } finally {
        // --- RACE CONDITION PREVENTION ---
        // After the save attempt (success or fail), we clear the ref.
        // This 'un-silences' the onSnapshot listener for the next legitimate server update.
        savingTreeRef.current = null;
        // ---------------------------------
      }
    }, 1000);

    return () => clearTimeout(saveTimeoutRef.current);
  }, [tree, user, isLoaded]);

  // --- Focus Restoration ---
  useEffect(() => {
    if (pendingFocus.current && inputRefs.current[pendingFocus.current]) {
      inputRefs.current[pendingFocus.current].focus();
      pendingFocus.current = null;
    }
  }, [visibleItems, focusedId]);

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

  // --- Actions ---

  const updateText = (id, newText) => {
    const newTree = cloneTree(tree);
    const path = findNodePath(newTree, id);
    if (path) {
      path[path.length - 1].nodes[path[path.length - 1].index].text = newText;
      setTree(newTree);
    }
  };

  const toggleCollapse = (id) => {
    const newTree = cloneTree(tree);
    const path = findNodePath(newTree, id);
    if (path) {
      const node = path[path.length - 1].node;
      node.collapsed = !node.collapsed;
      setTree(newTree);
    }
  };

  const toggleComplete = (id) => {
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
    }
  };

  const addNode = (afterId, isSection = false) => {
    const newTree = cloneTree(tree);
    const newNode = { id: generateId(), text: '', completed: false, collapsed: false, children: [] };
    
    const path = findNodePath(newTree, afterId);
    if (path) {
      const { nodes, index } = path[path.length - 1];
      nodes.splice(index + 1, 0, newNode);
      setTree(newTree);
      // Ensure the new node becomes the focused edit target and we request focus
      setFocusedId(newNode.id);
      pendingFocus.current = newNode.id;
    }
  };

  // Used only for empty state recovery
  const addRootNode = () => {
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
        // Put the new root section into edit mode and request focus
        setFocusedId(newSectionId);
        pendingFocus.current = newSectionId;
  };

  const deleteNode = (id) => {
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
      if (nextFocusId) {
        // make sure the next item is focused after deletion
        setFocusedId(nextFocusId);
        pendingFocus.current = nextFocusId;
      } else {
        // If there is nothing to focus, clear the focusedId
        setFocusedId(null);
      }
    }
  };

  const indentNode = (id) => {
    const newTree = cloneTree(tree);
    const path = findNodePath(newTree, id);
    if (!path) return;

    const { nodes, index } = path[path.length - 1];
    if (index === 0) return; // Can't indent first item

    // Removed the check that blocked root-level indentations
    
    const prevSibling = nodes[index - 1];
    const nodeToMove = nodes[index];

    nodes.splice(index, 1);
    if (!prevSibling.children) prevSibling.children = [];
    prevSibling.children.push(nodeToMove);
    prevSibling.collapsed = false;

    setTree(newTree);
    // Keep edit focus on the moved item
    setFocusedId(id);
    pendingFocus.current = id;
  };

  const outdentNode = (id) => {
    const newTree = cloneTree(tree);
    const path = findNodePath(newTree, id);
    if (!path || path.length < 2) return;

    const currentLevel = path[path.length - 1];
    const parentLevel = path[path.length - 2];

    const nodeToMove = currentLevel.nodes[currentLevel.index];
    currentLevel.nodes.splice(currentLevel.index, 1);
    parentLevel.nodes.splice(parentLevel.index + 1, 0, nodeToMove);

    setTree(newTree);
    // Keep edit focus on the moved item
    setFocusedId(id);
    pendingFocus.current = id;
  };

  const moveNode = (draggedId, targetId, position) => {
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
  };

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
        // Put the previous item in edit mode and request focus
        setFocusedId(prevId);
        pendingFocus.current = prevId;
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const index = visibleItems.findIndex(item => item.id === id);
      if (index < visibleItems.length - 1) {
        const nextId = visibleItems[index + 1].id;
        // Put the next item in edit mode and request focus
        setFocusedId(nextId);
        pendingFocus.current = nextId;
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
  
  if (!isLoaded && !tree.length) {
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
                      autoFocus
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
                      onClick={() => {
                        setFocusedId(item.id);
                        pendingFocus.current = item.id;
                      }}
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
                      {parseTextToLinks(item.text)}
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