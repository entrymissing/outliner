import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { GripVertical, ChevronRight, ChevronDown, Plus, Trash2, Cloud, CloudOff, CheckCircle2, Circle, Loader2, Eye, EyeOff, X, User } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, collection } from 'firebase/firestore';

// --- Firebase Configuration & Initialization ---
const firebaseConfig = {
  apiKey: "AIzaSyCmmf4tX88LyjFhPBkTRyfJNF7vK6Qyn3w",
  authDomain: "outliner-7ac92.firebaseapp.com",
  projectId: "outliner-7ac92",
  storageBucket: "outliner-7ac92.firebasestorage.app",
  messagingSenderId: "482247278746",
  appId: "1:482247278746:web:b17c4951510bf5a3ac5f23",
  measurementId: "G-CBZP7BDF3X"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// --- Utility Functions for Tree Management ---

const generateId = () => Math.random().toString(36).substr(2, 9);

// Flatten the tree into a linear list for rendering and keyboard navigation logic
const flattenTree = (nodes, depth = 0, visibleList = [], showCompleted = false) => {
  nodes.forEach(node => {
    // Filter out completed items if showCompleted is false
    if (!showCompleted && node.completed) return;

    visibleList.push({ ...node, depth });
    if (!node.collapsed && node.children && node.children.length > 0) {
      flattenTree(node.children, depth + 1, visibleList, showCompleted);
    }
  });
  return visibleList;
};

// Deep clone helper
const cloneTree = (items) => JSON.parse(JSON.stringify(items));

// Recursive search to find a node and its path
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

const DEFAULT_TREE = [
  { id: '1', text: 'Welcome to your Project Manager', completed: false, collapsed: false, children: [
    { id: '2', text: 'Hover over a bullet to see the Trash icon', completed: false, collapsed: false, children: [] },
    { id: '3', text: 'Click the circle to mark as done', completed: false, collapsed: false, children: [
        { id: '4', text: 'Completing a parent completes all children', completed: false, collapsed: false, children: [] }
    ]},
  ]},
  { id: '5', text: 'Completed items are hidden by default', completed: true, collapsed: false, children: [
      { id: '6', text: 'Use the Eye icon in the header to see me', completed: true, collapsed: false, children: [] }
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
  
  // Refs
  const inputRefs = useRef({});
  const pendingFocus = useRef(null);
  const saveTimeoutRef = useRef(null);

  // Drag and Drop State
  const [draggedItem, setDraggedItem] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  // Flatten tree for rendering logic, passing the visibility filter
  const visibleItems = flattenTree(tree, 0, [], showCompleted);

  // --- Authentication Effect ---
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

  // --- Data Sync Effect ---
  useEffect(() => {
    if (!user) return;

    const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'data', 'workflowy');
    
    // We unsubscribe from previous listener if this effect re-runs
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data().tree;
        // Only update state if data is actually different to prevent loops/jitters
        if (JSON.stringify(data) !== JSON.stringify(tree)) {
             setTree(data);
        }
        setIsLoaded(true);
      } else {
        // Logic: If document doesn't exist, we initialize it.
        // This happens for NEW users. It does NOT overwrite existing data for existing users.
        setTree(DEFAULT_TREE);
        setDoc(docRef, { tree: DEFAULT_TREE });
        setIsLoaded(true);
      }
    }, (error) => {
      console.error("Error fetching document:", error);
      setSaveStatus('error');
    });

    return () => unsubscribe();
  }, [user]); // Removed isLoaded to prevent double-subscription, user is the main key

  // --- Auto-Save Effect ---
  useEffect(() => {
    if (!user || !isLoaded) return;

    // Don't save if the tree is empty (unless it was intentionally emptied, but here it prevents initial load override)
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
      const { nodes, index } = path[path.length - 1];
      nodes[index].text = newText;
      setTree(newTree);
    }
  };

  const toggleCollapse = (id) => {
    const newTree = cloneTree(tree);
    const path = findNodePath(newTree, id);
    if (path) {
      const { node } = path[path.length - 1];
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
      
      // If marking as complete, recursively mark children as complete
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

  const addNode = (afterId) => {
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

  const deleteNode = (id) => {
    const currentIndex = visibleItems.findIndex(item => item.id === id);
    
    // Calculate focus target before deletion
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
        pendingFocus.current = nextFocusId;
      }
    }
  };

  const indentNode = (id) => {
    const newTree = cloneTree(tree);
    const path = findNodePath(newTree, id);
    if (!path) return;

    const { nodes, index } = path[path.length - 1];
    if (index === 0) return;

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

  const handleKeyDown = (e, id, text) => {
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

  // --- Drag & Drop Handlers ---

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
    if (offsetY < rect.height * 0.25) position = 'before';
    else if (offsetY > rect.height * 0.75) position = 'after';

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
                  <Loader2 className="animate-spin" /> Loading your projects...
              </div>
          </div>
      );
  }

  return (
    <div className="min-h-screen bg-white text-gray-800 font-sans selection:bg-blue-100 p-8">
      <div className="max-w-4xl mx-auto relative">
        
        {/* Header area */}
        <div className="flex items-center justify-between mb-8">
            <h1 className="text-3xl font-bold text-gray-900">My Projects</h1>
            
            <div className="flex items-center gap-6">
                {/* Visibility Toggle */}
                <button 
                    onClick={() => setShowCompleted(!showCompleted)}
                    className="flex items-center gap-2 text-sm font-medium text-gray-500 hover:text-gray-800 transition-colors"
                >
                    {showCompleted ? (
                        <>
                            <Eye size={16} />
                            Hide Completed
                        </>
                    ) : (
                        <>
                            <EyeOff size={16} />
                            Show Completed
                        </>
                    )}
                </button>

                {/* Sync Indicator */}
                <div className="flex items-center gap-2 text-sm font-medium text-gray-400 w-20 justify-end">
                    {saveStatus === 'saving' && (
                        <>
                            <Loader2 size={14} className="animate-spin text-blue-500" />
                            <span className="text-blue-500">Saving...</span>
                        </>
                    )}
                    {saveStatus === 'saved' && (
                        <>
                            <CheckCircle2 size={14} className="text-green-500" />
                            <span className="text-green-600">Saved</span>
                        </>
                    )}
                    {saveStatus === 'error' && (
                        <>
                            <CloudOff size={14} className="text-red-500" />
                            <span className="text-red-500">Offline</span>
                        </>
                    )}
                </div>
            </div>
        </div>
        
        <div className="space-y-1 pb-40">
          {visibleItems.map((item) => {
            const isDragging = draggedItem?.id === item.id;
            const isDropTarget = dropTarget?.id === item.id;
            
            return (
              <div 
                key={item.id}
                className={`
                  relative group flex items-start transition-all duration-100 pr-4
                  ${isDragging ? 'opacity-30' : 'opacity-100'}
                `}
                style={{ paddingLeft: `${item.depth * 24}px` }}
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
                
                <div className="relative flex items-center w-14 mr-1 shrink-0 h-7">
                  {/* Collapse Toggle */}
                  {item.children && item.children.length > 0 && (
                    <button 
                      onClick={() => toggleCollapse(item.id)}
                      className="absolute left-0 text-gray-400 hover:text-gray-600 p-1"
                      tabIndex={-1}
                    >
                      {item.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </button>
                  )}

                  {/* Draggable Bullet */}
                  <div 
                    className={`
                      absolute left-5 w-1.5 h-1.5 rounded-full cursor-move z-20
                      ${isDropTarget && dropTarget.position === 'inside' 
                        ? 'ring-4 ring-blue-200 bg-blue-600 scale-125' 
                        : 'bg-gray-300 group-hover:bg-gray-500'}
                    `}
                    draggable
                    onDragStart={(e) => handleDragStart(e, item)}
                  >
                    <div className="absolute -inset-3 bg-transparent" />
                  </div>

                   {/* Completion Checkbox */}
                   <button 
                      onClick={() => toggleComplete(item.id)}
                      className={`
                        absolute left-8 p-0.5 rounded hover:bg-gray-100 transition-colors
                        ${item.completed ? 'text-green-500' : 'text-gray-300 hover:text-gray-400'}
                      `}
                      tabIndex={-1}
                   >
                      {item.completed ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                   </button>

                </div>

                {/* Input Field */}
                <div className="relative flex-1">
                    <input
                    ref={(el) => (inputRefs.current[item.id] = el)}
                    value={item.text}
                    onChange={(e) => updateText(item.id, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(e, item.id, item.text)}
                    onFocus={() => setFocusedId(item.id)}
                    className={`
                        w-full bg-transparent outline-none leading-relaxed transition-all
                        ${item.completed ? 'line-through text-gray-400' : 'text-gray-800'}
                    `}
                    placeholder="Type something..."
                    />
                </div>

                {/* Delete Action (Hover only) */}
                <button 
                    onClick={() => deleteNode(item.id)}
                    className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-opacity px-2"
                    title="Delete item"
                    tabIndex={-1}
                >
                    <Trash2 size={14} />
                </button>
              </div>
            );
          })}

          {visibleItems.length === 0 && (
             <div className="text-center py-20 text-gray-400 italic">
                 {showCompleted ? "No items found." : "All items are completed and hidden."}
             </div>
          )}
        </div>
        
        <div 
          onClick={() => {
            const newId = generateId();
            setTree([...tree, { id: newId, text: '', children: [] }]);
            setTimeout(() => inputRefs.current[newId]?.focus(), 10);
          }}
          className="flex items-center text-gray-400 hover:text-gray-600 cursor-pointer mt-4 ml-8"
        >
          <Plus size={16} className="mr-2" /> Click to add item
        </div>
      </div>
      
      {/* Help Footer */}
      <div className="fixed bottom-4 right-4 bg-gray-100 p-4 rounded-lg text-xs text-gray-500 border border-gray-200 shadow-sm flex items-center gap-4">
        <div>
            <p className="font-semibold mb-1">Keyboard Shortcuts:</p>
            <ul className="space-y-1">
            <li><kbd className="bg-white px-1 border rounded">Tab</kbd> Indent</li>
            <li><kbd className="bg-white px-1 border rounded">Shift+Tab</kbd> Outdent</li>
            <li><kbd className="bg-white px-1 border rounded">↑</kbd> <kbd className="bg-white px-1 border rounded">↓</kbd> Navigate</li>
            </ul>
        </div>
        
        <div className="h-full w-px bg-gray-200 mx-1"></div>

        {/* User ID Debugger */}
        <div className="text-gray-400 flex flex-col justify-center min-w-[80px]">
             <div className="flex items-center gap-1 mb-1" title="If this ID changes, your data resets">
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