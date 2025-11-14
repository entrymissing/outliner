import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { GripVertical, ChevronRight, ChevronDown, Plus, Trash2, Cloud, CloudOff, CheckCircle2, Circle, Loader2, Eye, EyeOff, X, User } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, collection } from 'firebase/firestore';

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
  const [isLoaded, setIsLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState('idle'); 
  const [showCompleted, setShowCompleted] = useState(false);
  const [focusedId, setFocusedId] = useState(null);
  
  const inputRefs = useRef({});
  const pendingFocus = useRef(null);
  const saveTimeoutRef = useRef(null);

  const [draggedItem, setDraggedItem] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const visibleItems = flattenTree(tree, 0, [], showCompleted);

  // --- Auth ---
  useEffect(() => {
    const initAuth = async () => {
      if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
        await signInWithCustomToken(auth, __initial_auth_token);
      } else {
        await signInAnonymously(auth);
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // --- Sync (Load) ---
  useEffect(() => {
    if (!user) return;
    const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'data', 'workflowy');
    
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        // Update Tree (prevent loops)
        if (JSON.stringify(data.tree) !== JSON.stringify(tree)) {
             setTree(data.tree || []);
        }
        setIsLoaded(true);
      } else {
        setTree(DEFAULT_TREE);
        setDoc(docRef, { tree: DEFAULT_TREE });
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

    setSaveStatus('saving');
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'data', 'workflowy');
        await setDoc(docRef, { tree }, { merge: true });
        setSaveStatus('saved');
      } catch (err) {
        console.error("Error saving:", err);
        setSaveStatus('error');
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
  }, [visibleItems]);

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
      if (nextFocusId) pendingFocus.current = nextFocusId;
    }
  };

  const indentNode = (id) => {
    const newTree = cloneTree(tree);
    const path = findNodePath(newTree, id);
    if (!path) return;

    const { nodes, index } = path[path.length - 1];
    if (index === 0) return; // Can't indent first item

    // Rule: Don't allow indenting a Section (depth 0) into another Section
    if (nodes === newTree) return; 

    const prevSibling = nodes[index - 1];
    const nodeToMove = nodes[index];

    nodes.splice(index, 1);
    if (!prevSibling.children) prevSibling.children = [];
    prevSibling.children.push(nodeToMove);
    prevSibling.collapsed = false;

    setTree(newTree);
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
        inputRefs.current[prevId]?.focus();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const index = visibleItems.findIndex(item => item.id === id);
      if (index < visibleItems.length - 1) {
        const nextId = visibleItems[index + 1].id;
        inputRefs.current[nextId]?.focus();
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
    <div className="min-h-screen bg-gray-50 text-gray-800 font-sans selection:bg-blue-100 p-8">
      <div className="max-w-4xl mx-auto relative bg-white min-h-[80vh] shadow-sm rounded-xl p-8 border border-gray-100">
        
        {/* Header area */}
        <div className="flex items-center justify-end mb-6 border-b border-gray-100 pb-4">
            
            <div className="flex items-center gap-6">
                <button 
                    onClick={() => setShowCompleted(!showCompleted)}
                    className="flex items-center gap-2 text-sm font-medium text-gray-500 hover:text-gray-800 transition-colors"
                >
                    {showCompleted ? <Eye size={16} /> : <EyeOff size={16} />}
                    {showCompleted ? 'Hide Done' : 'Show Done'}
                </button>

                <div className="flex items-center gap-2 text-sm font-medium text-gray-400 w-20 justify-end">
                    {saveStatus === 'saving' && <Loader2 size={14} className="animate-spin text-blue-500" />}
                    {saveStatus === 'saved' && <CheckCircle2 size={14} className="text-green-500" />}
                    {saveStatus === 'error' && <CloudOff size={14} className="text-red-500" />}
                    <span className={saveStatus === 'saved' ? 'text-green-600' : ''}>
                        {saveStatus === 'saving' ? 'Saving' : saveStatus === 'saved' ? 'Saved' : 'Offline'}
                    </span>
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
                
                <div className="relative flex items-center w-14 mr-1 shrink-0 h-7 self-start mt-0.5">
                   {/* Draggable Handle (Left of Bullet) */}
                   <div 
                    className={`
                      absolute left-0 cursor-move opacity-0 group-hover:opacity-30 hover:!opacity-100 transition-opacity
                    `}
                    draggable
                    onDragStart={(e) => handleDragStart(e, item)}
                   >
                        <GripVertical size={16} />
                   </div>

                  {/* Collapse Toggle */}
                  {item.children && item.children.length > 0 && (
                    <button 
                      onClick={() => toggleCollapse(item.id)}
                      className={`
                          absolute text-gray-400 hover:text-gray-600 p-1
                          ${isSection ? 'left-4 top-0' : 'left-0'}
                      `}
                      tabIndex={-1}
                    >
                      {item.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </button>
                  )}

                   {/* Checkbox / Section Icon */}
                   {isSection ? (
                       // Section Header Icon (Layout icon implies "Section")
                        <div className="absolute left-8 top-1.5 text-gray-300">
                            <Layout size={16} />
                        </div>
                   ) : (
                       // Standard Checkbox
                        <button 
                            onClick={() => toggleComplete(item.id)}
                            className={`
                                absolute left-6 p-0.5 rounded hover:bg-gray-100 transition-colors
                                ${item.completed ? 'text-green-500' : 'text-gray-300 hover:text-gray-400'}
                            `}
                            tabIndex={-1}
                        >
                            {item.completed ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                        </button>
                   )}
                </div>

                {/* Input Field */}
                <div className={`relative flex-1 ${isSection ? 'border-b border-gray-200 pb-1' : ''}`}>
                    <input
                        ref={(el) => (inputRefs.current[item.id] = el)}
                        value={item.text}
                        onChange={(e) => updateText(item.id, e.target.value)}
                        onKeyDown={(e) => handleKeyDown(e, item.id, item.text, item.depth)}
                        onFocus={() => setFocusedId(item.id)}
                        className={`
                            w-full bg-transparent outline-none transition-all
                            ${isSection 
                                ? 'text-xl font-bold text-gray-800 placeholder-gray-300' 
                                : `leading-relaxed ${item.completed ? 'line-through text-gray-400' : 'text-gray-700'}`
                            }
                        `}
                        placeholder={isSection ? "Section Name" : "Type a task..."}
                    />
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
        <div>
            <p className="font-semibold mb-1">Shortcuts:</p>
            <ul className="space-y-1">
            <li><kbd className="bg-gray-50 px-1 border rounded">Tab</kbd> Indent</li>
            <li><kbd className="bg-gray-50 px-1 border rounded">Shift+Tab</kbd> Outdent</li>
            <li><kbd className="bg-gray-50 px-1 border rounded">Enter</kbd> New Item</li>
            </ul>
        </div>
        <div className="h-full w-px bg-gray-200 mx-1"></div>
        <div className="text-gray-400 flex flex-col justify-center min-w-[80px]">
             <div className="flex items-center gap-1 mb-1">
                 <User size={10} />
                 <span className="font-semibold">Session ID</span>
             </div>
             <code className="bg-gray-50 p-1 rounded border text-[10px] block w-full overflow-hidden text-ellipsis">
                 {user ? user.uid.slice(0, 8) : '...'}
             </code>
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