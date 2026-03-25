import React, { useState, useEffect, useRef, useMemo } from 'react';

// --- Constants & Utilities ---
const CATEGORIES = [
  { name: '餐飲', emoji: '🍜', color: '#c0392b' },
  { name: '交通', emoji: '🚇', color: '#2980b9' },
  { name: '住宿', emoji: '🏨', color: '#27ae60' },
  { name: '購物', emoji: '🛍️', color: '#8e44ad' },
  { name: '景點', emoji: '🗼', color: '#e67e22' },
  { name: '其他', emoji: '💴', color: '#7f8c8d' },
];

const getCategoryEmoji = (catName) => {
  const cat = CATEGORIES.find(c => c.name === catName);
  return cat ? cat.emoji : '💴';
};

const formatCurrency = (num) => {
  return new Intl.NumberFormat('en-US').format(Math.round(num));
};

const getTodayString = () => {
  const tzOffset = (new Date()).getTimezoneOffset() * 60000;
  return (new Date(Date.now() - tzOffset)).toISOString().split('T')[0];
};

// Delay for exponential backoff
const delay = (ms) => new Promise(res => setTimeout(res, ms));

// --- Cloud Sync Settings ---
// 🌟 步驟 4：將取得的 Google Apps Script 網址貼在下方引號內
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx8i1yb03bpXqpEp9HEpYcSQ6q9vNLFBq7LfuXkY_rfZCPcb1occUYts_2eEyplmwmV/exec'; 

// --- Gemini API Call ---
const analyzeReceiptWithGemini = async (base64Image, mimeType) => {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { 
            text: "請分析這張日本收據。提取出店名(name，請務必將日文翻譯成繁體中文，例如「セブン-イレブン 博多駅前朝日ビル店」需回傳「7-Eleven 博多站朝日大樓店」)、日期(date, 格式為 YYYY-MM-DD)、總金額(amountJpy, 僅數字)、最適當的類別(category, 必須是以下之一：餐飲, 交通, 購物, 住宿, 景點, 其他)、以及簡單的備註(note, 例如買了什麼)。金額請確保是日圓(JPY)。若日期包含漢字(年/月/日)請轉換為標準的 YYYY-MM-DD。" 
          },
          { 
            inlineData: { mimeType: mimeType, data: base64Image } 
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          date: { type: "STRING", description: "YYYY-MM-DD" },
          amountJpy: { type: "INTEGER" },
          category: { type: "STRING", enum: ["餐飲", "交通", "購物", "住宿", "景點", "其他"] },
          note: { type: "STRING" }
        },
        required: ["name", "date", "amountJpy", "category"]
      }
    }
  };

  const retries = [1000, 2000, 4000, 8000, 16000];
  
  for (let attempt = 0; attempt <= retries.length; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const result = await response.json();
      const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!textResponse) throw new Error("無效的 API 回應");
      
      let parsedData = JSON.parse(textResponse);
      
      // Handle Japanese date formats like "25-09-11" or "25.09.11"
      if (parsedData.date) {
        let d = parsedData.date.replace(/[年|月|\/|\.]/g, '-').replace(/[日]/g, '');
        let parts = d.split('-').filter(p => p !== '');
        if (parts[0] && parts[0].length === 2) parts[0] = '20' + parts[0];
        if (parts[1] && parts[1].length === 1) parts[1] = '0' + parts[1];
        if (parts[2] && parts[2].length === 1) parts[2] = '0' + parts[2];
        if (parts.length === 3) parsedData.date = parts.join('-');
      }

      return parsedData;
      
    } catch (error) {
      if (attempt === retries.length) {
        console.error("Gemini API Error after retries:", error);
        throw new Error("AI 辨識失敗，請稍後再試或手動輸入。");
      }
      await delay(retries[attempt]);
    }
  }
};

// --- Main App Component ---
export default function App() {
  // State
  const [tab, setTab] = useState('home');
  const [expenses, setExpenses] = useState([]);
  const [settings, setSettings] = useState({ exchangeRate: 0.22, dailyBudgetJpy: 10000 });
  const [isSyncing, setIsSyncing] = useState(false);

  // Quick Add Form State
  const [quickName, setQuickName] = useState('');
  const [quickAmount, setQuickAmount] = useState('');
  const [quickCat, setQuickCat] = useState('餐飲');
  const [quickDate, setQuickDate] = useState(getTodayString());
  const [quickNote, setQuickNote] = useState('');

  // Modals & UI State
  const [isEditing, setIsEditing] = useState(false);
  const [currentExpense, setCurrentExpense] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  
  const fileInputRef = useRef(null);

  // Initial Load & Cloud Fetch
  useEffect(() => {
    // 1. 先快速載入本機資料，讓畫面不要白屏
    const savedExpenses = localStorage.getItem('jp_records_v2');
    if (savedExpenses) setExpenses(JSON.parse(savedExpenses));
    
    const savedSettings = localStorage.getItem('jp_settings_v2');
    if (savedSettings) setSettings(JSON.parse(savedSettings));

    // 2. 如果有設定 SCRIPT_URL，就在背景抓取最新的雲端資料
    const fetchCloudData = async () => {
      if (!SCRIPT_URL) return;
      setIsSyncing(true);
      try {
        const res = await fetch(SCRIPT_URL);
        const cloudData = await res.json();
        if (Array.isArray(cloudData)) {
          setExpenses(cloudData);
          localStorage.setItem('jp_records_v2', JSON.stringify(cloudData));
        }
      } catch (err) {
        console.error('Cloud sync failed:', err);
      } finally {
        setIsSyncing(false);
      }
    };

    fetchCloudData();
  }, []);

  // Save Settings to LocalStorage (Expenses are saved synchronously too)
  useEffect(() => {
    localStorage.setItem('jp_records_v2', JSON.stringify(expenses));
    localStorage.setItem('jp_settings_v2', JSON.stringify(settings));
  }, [expenses, settings]);

  // Derived Data
  const totalJpy = expenses.reduce((sum, exp) => sum + exp.amountJpy, 0);
  const totalTwd = totalJpy * settings.exchangeRate;
  
  const sortedExpenses = [...expenses].sort((a, b) => new Date(b.date) - new Date(a.date));
  
  const expensesByDate = useMemo(() => {
    return sortedExpenses.reduce((acc, exp) => {
      if (!acc[exp.date]) acc[exp.date] = [];
      acc[exp.date].push(exp);
      return acc;
    }, {});
  }, [sortedExpenses]);

  // Cloud Sync Helper
  const syncToCloud = async (payload) => {
    if (!SCRIPT_URL) return;
    setIsSyncing(true);
    try {
      // 故意使用 text/plain 可以繞過 GAS 惱人的 CORS Preflight 限制
      await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.error('Failed to sync to cloud', err);
    } finally {
      setIsSyncing(false);
    }
  };

  // Actions
  const handleQuickAdd = () => {
    if (!quickName || !quickAmount) return alert('請填寫名稱與金額');
    const newExp = {
      id: Date.now().toString(),
      name: quickName,
      amountJpy: Number(quickAmount),
      category: quickCat,
      date: quickDate || getTodayString(),
      note: quickNote
    };
    
    setExpenses(prev => [...prev, newExp]);
    setQuickName('');
    setQuickAmount('');
    setQuickNote('');
    
    // 背景同步到 Google Sheets
    syncToCloud({ action: 'add', data: newExp });
  };

  const handleSaveExpense = () => {
    if (!currentExpense.name || !currentExpense.amountJpy || !currentExpense.date) return;
    
    const newExp = { ...currentExpense, amountJpy: Number(currentExpense.amountJpy) };

    setExpenses(prev => {
      const exists = prev.find(p => p.id === newExp.id);
      if (exists) return prev.map(p => p.id === newExp.id ? newExp : p);
      return [...prev, newExp];
    });
    
    setIsEditing(false);
    setCurrentExpense(null);

    // 背景同步到 Google Sheets
    syncToCloud({ action: 'edit', data: newExp });
  };

  const handleDeleteExpense = (id) => {
    if(confirm("確定要刪除這筆紀錄嗎？")) {
      setExpenses(prev => prev.filter(e => e.id !== id));
      setIsEditing(false);

      // 背景同步到 Google Sheets
      syncToCloud({ action: 'delete', id: id });
    }
  };

  const clearAll = () => {
    if(confirm('確定清除手機內的所有紀錄？注意：此動作不會刪除 Google 雲端上的資料。')) {
      setExpenses([]);
    }
  };

  const triggerCamera = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsScanning(true);
    setScanStatus('正在解析日本收據格式...');
    
    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Data = reader.result.split(',')[1];
        try {
          const aiData = await analyzeReceiptWithGemini(base64Data, file.type);
          setCurrentExpense({
            id: Date.now().toString(),
            name: aiData.name || '',
            date: aiData.date || getTodayString(),
            amountJpy: aiData.amountJpy || '',
            category: aiData.category || '其他',
            note: aiData.note || ''
          });
          setIsScanning(false);
          setIsEditing(true); // Open modal for confirmation
        } catch (error) {
          alert(error.message);
          setIsScanning(false);
        }
      };
      reader.readAsDataURL(file);
    } catch (err) {
      alert("讀取圖片失敗");
      setIsScanning(false);
    }
    e.target.value = '';
  };

  const exportCSV = () => {
    const headers = ["日期", "名稱", "類別", "日圓", "台幣", "備註"];
    const rows = sortedExpenses.map(e => [
      e.date,
      `"${e.name}"`,
      e.category,
      e.amountJpy,
      Math.round(e.amountJpy * settings.exchangeRate),
      `"${e.note || ''}"`
    ]);
    const csvContent = "data:text/csv;charset=utf-8,\uFEFF" + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `日本旅遊記帳.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // --- UI Sections ---

  const renderHome = () => (
    <div className="p-4 pb-24 space-y-4 animate-in fade-in font-zen">
      {/* Summary Grid */}
      <div className="grid grid-cols-2 gap-3 mb-2">
        <div className="bg-[#fffdf8] border border-[#d4c4a8] border-l-4 border-l-[#c0392b] rounded-xl p-4 shadow-sm">
          <div className="text-[0.7rem] text-[#c0392b] font-bold mb-1">總花費 JPY</div>
          <div className="font-mincho text-2xl font-semibold text-[#1a1209]">¥{formatCurrency(totalJpy)}</div>
        </div>
        <div className="bg-[#fffdf8] border border-[#d4c4a8] border-l-4 border-l-[#2980b9] rounded-xl p-4 shadow-sm">
          <div className="text-[0.7rem] text-[#2980b9] font-bold mb-1">換算 TWD</div>
          <div className="font-mincho text-2xl font-semibold text-[#1a1209]">NT${formatCurrency(totalTwd)}</div>
        </div>
      </div>

      {/* Scan Section */}
      <div 
        onClick={triggerCamera}
        className="bg-[#fffdf8] border-2 border-dashed border-[#d4c4a8] rounded-2xl p-6 text-center cursor-pointer active:scale-95 transition-transform shadow-sm"
      >
        <div className="text-4xl mb-2">📷</div>
        <div className="font-bold text-[#1a1209] mb-1">拍攝收據自動記帳</div>
        <div className="text-[0.7rem] text-[#8c7b6b] mt-1">✨ AI自動辨識日期、品項、金額、類別</div>
      </div>

      {/* Manual Form */}
      <div className="bg-[#fffdf8] border border-[#d4c4a8] rounded-2xl p-4 shadow-sm">
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-[0.75rem] text-[#1a1209] mb-1">名稱</label>
            <input type="text" value={quickName} onChange={e=>setQuickName(e.target.value)} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#faf6ef] text-[0.95rem] focus:outline-none focus:border-[#d4a017]" />
          </div>
          <div>
            <label className="block text-[0.75rem] text-[#1a1209] mb-1">金額 (¥)</label>
            <input type="number" value={quickAmount} onChange={e=>setQuickAmount(e.target.value)} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#faf6ef] text-[0.95rem] focus:outline-none focus:border-[#d4a017]" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-[0.75rem] text-[#1a1209] mb-1">類別</label>
            <select value={quickCat} onChange={e=>setQuickCat(e.target.value)} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#faf6ef] text-[0.95rem] focus:outline-none focus:border-[#d4a017]">
              {CATEGORIES.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[0.75rem] text-[#1a1209] mb-1">日期</label>
            <input type="date" value={quickDate} onChange={e=>setQuickDate(e.target.value)} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#faf6ef] text-[0.95rem] focus:outline-none focus:border-[#d4a017]" />
          </div>
        </div>
        <div className="mb-4">
          <label className="block text-[0.75rem] text-[#1a1209] mb-1">備註 (選填)</label>
          <input type="text" value={quickNote} onChange={e=>setQuickNote(e.target.value)} placeholder="新增備註..." className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#faf6ef] text-[0.95rem] focus:outline-none focus:border-[#d4a017]" />
        </div>
        <button onClick={handleQuickAdd} className="w-full bg-[#c0392b] text-white py-3 rounded-xl font-bold tracking-wide active:scale-95 transition-transform shadow-sm">
          ＋ 新增記帳
        </button>
      </div>

      {/* Recent List */}
      {expenses.length > 0 && (
        <div className="mt-2">
          <h4 className="text-[0.8rem] text-[#8c7b6b] font-bold mb-2 ml-1">最近紀錄</h4>
          <div className="space-y-2">
            {sortedExpenses.slice(0, 5).map(exp => (
              <div key={exp.id} onClick={() => { setCurrentExpense(exp); setIsEditing(true); }} className="bg-[#fffdf8] border border-[#d4c4a8] rounded-xl p-3 flex items-center justify-between cursor-pointer active:bg-[#f0e8d8] transition-colors">
                <div className="flex-1 overflow-hidden pr-2">
                  <div className="font-bold text-[#1a1209] text-[0.95rem] truncate">
                    <span className="mr-1">{getCategoryEmoji(exp.category)}</span> {exp.name}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-[0.75rem] text-[#8c7b6b] truncate">
                    <span>{exp.date}</span>
                    {exp.note && <span className="truncate opacity-80">· {exp.note}</span>}
                  </div>
                </div>
                <div className="text-[#c0392b] font-bold tracking-wide shrink-0">¥{formatCurrency(exp.amountJpy)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const renderList = () => (
    <div className="p-4 pb-24 space-y-2 animate-in fade-in font-zen">
      {Object.keys(expensesByDate).length === 0 ? (
        <div className="text-center text-[#8c7b6b] mt-20">尚無記帳紀錄</div>
      ) : (
        Object.entries(expensesByDate).map(([date, dateExpenses]) => {
          const dayTotalJpy = dateExpenses.reduce((sum, e) => sum + e.amountJpy, 0);
          const dayTotalTwd = Math.round(dayTotalJpy * settings.exchangeRate);
          const dayCount = dateExpenses.length;

          return (
            <div key={date} className="mb-4">
              <div className="flex justify-between items-end border-b border-[#d4c4a8] pb-1 mb-2 mt-4 ml-1 pr-1">
                <div className="text-[0.8rem] text-[#8c7b6b] font-bold">
                  {date} <span className="text-[0.7rem] font-normal ml-1">({dayCount}筆)</span>
                </div>
                <div className="text-[0.8rem] text-[#8c7b6b] font-bold">
                  ¥{formatCurrency(dayTotalJpy)} <span className="text-[0.7rem] font-normal">/ NT${formatCurrency(dayTotalTwd)}</span>
                </div>
              </div>
              <div className="space-y-2">
                {dateExpenses.map(exp => (
                  <div key={exp.id} onClick={() => { setCurrentExpense(exp); setIsEditing(true); }} className="bg-[#fffdf8] border border-[#d4c4a8] rounded-xl p-3 flex items-center justify-between cursor-pointer active:bg-[#f0e8d8] transition-colors">
                    <div className="flex-1 overflow-hidden pr-2">
                      <div className="font-bold text-[#1a1209] text-[0.9rem] flex items-center gap-2 truncate">
                        <span className="text-lg shrink-0">{getCategoryEmoji(exp.category)}</span>
                        <span className="truncate">{exp.name}</span>
                      </div>
                      {exp.note && <div className="text-[0.75rem] text-[#8c7b6b] mt-0.5 ml-7 truncate opacity-80">{exp.note}</div>}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[#c0392b] font-bold tracking-wide">¥{formatCurrency(exp.amountJpy)}</div>
                      <div className="text-[0.7rem] text-[#8c7b6b] mt-0.5">NT${formatCurrency(exp.amountJpy * settings.exchangeRate)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );

  const renderAnalytics = () => {
    const categoryTotals = CATEGORIES.map(cat => ({
      ...cat,
      amount: expenses.filter(e => e.category === cat.name).reduce((sum, e) => sum + e.amountJpy, 0)
    })).filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount);

    let currentPct = 0;
    const conicGradientStr = categoryTotals.map(cat => {
      const pct = (cat.amount / totalJpy) * 100;
      const start = currentPct;
      const end = currentPct + pct;
      currentPct = end;
      return `${cat.color} ${start}% ${end}%`;
    }).join(', ');

    return (
      <div className="p-4 pb-24 space-y-6 animate-in fade-in font-zen">
        {totalJpy === 0 ? (
          <div className="text-center text-[#8c7b6b] mt-20">暫無數據可分析</div>
        ) : (
          <div className="bg-[#fffdf8] p-6 rounded-2xl shadow-sm border border-[#d4c4a8] mt-4">
            <h3 className="font-bold text-[#1a1209] mb-8 text-center text-lg">消費類別佔比</h3>
            
            <div className="flex justify-center mb-8">
              <div 
                className="w-48 h-48 rounded-full shadow-inner relative"
                style={{ background: `conic-gradient(${conicGradientStr})` }}
              >
                <div className="absolute inset-4 bg-[#fffdf8] rounded-full flex items-center justify-center shadow-sm">
                  <div className="text-center">
                    <p className="text-xs text-[#8c7b6b]">總計</p>
                    <p className="font-mincho font-bold text-[#1a1209] text-sm mt-1">¥{formatCurrency(totalJpy)}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              {categoryTotals.map(cat => (
                <div key={cat.name} className="flex items-center justify-between text-[0.95rem]">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: cat.color }}></div>
                    <span className="text-[#1a1209] font-medium">{cat.emoji} {cat.name}</span>
                  </div>
                  <div className="flex gap-4">
                    <span className="font-bold text-[#1a1209]">¥{formatCurrency(cat.amount)}</span>
                    <span className="text-[#8c7b6b] w-10 text-right text-xs pt-0.5">{Math.round((cat.amount/totalJpy)*100)}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderSettings = () => (
    <div className="p-4 pb-24 space-y-6 animate-in fade-in font-zen">
      <div className="bg-[#fffdf8] border border-[#d4c4a8] rounded-2xl p-5 mt-4">
        
        <label className="block text-sm font-bold text-[#1a1209] mb-2">日圓匯率 (1 JPY = ? TWD)</label>
        <input 
          type="number" 
          step="0.0001" 
          value={settings.exchangeRate} 
          onChange={e => setSettings({...settings, exchangeRate: parseFloat(e.target.value) || 0})} 
          className="w-full p-3 border border-[#d4c4a8] rounded-xl bg-[#faf6ef] mb-6 focus:outline-none focus:border-[#d4a017]" 
        />

        <label className="block text-sm font-bold text-[#1a1209] mb-2">每日預算 (日圓)</label>
        <input 
          type="number" 
          value={settings.dailyBudgetJpy} 
          onChange={e => setSettings({...settings, dailyBudgetJpy: parseInt(e.target.value) || 0})} 
          className="w-full p-3 border border-[#d4c4a8] rounded-xl bg-[#faf6ef] mb-8 focus:outline-none focus:border-[#d4a017]" 
        />

        <button onClick={exportCSV} className="w-full bg-[#f0e8d8] border border-[#d4c4a8] text-[#1a1209] font-bold py-3 rounded-xl mb-3 shadow-sm active:scale-95 transition-transform">
          📤 匯出 CSV
        </button>
        <button onClick={clearAll} className="w-full bg-[#f0e8d8] border border-[#d4c4a8] text-[#c0392b] font-bold py-3 rounded-xl shadow-sm active:scale-95 transition-transform">
          🗑️ 清除所有資料
        </button>

      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#faf6ef] font-sans text-[#1a1209] max-w-md mx-auto relative shadow-2xl overflow-hidden">
      
      {/* Dynamic Font Styles Injection */}
      <style dangerouslySetInnerHTML={{__html: `
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;600;700&family=Zen+Kaku+Gothic+New:wght@300;400;700&family=Shippori+Mincho:wght@400;600&display=swap');
        .font-mincho { font-family: 'Shippori Mincho', 'Noto Serif TC', serif; }
        .font-zen { font-family: 'Zen Kaku Gothic New', sans-serif; }
        .custom-scrollbar::-webkit-scrollbar { width: 0px; background: transparent; }
      `}} />

      {/* Hidden File Input for Camera/Album */}
      <input type="file" accept="image/*" capture="environment" ref={fileInputRef} onChange={handleFileChange} className="hidden" />

      {/* Main Content Area */}
      <div className="h-screen overflow-y-auto custom-scrollbar">
        {/* Header */}
        <header className="sticky top-0 bg-[#1a1209] text-[#faf6ef] z-10 px-5 py-4 flex justify-between items-center shadow-md">
          <div className="flex items-center gap-2">
            <span className="text-[1.3rem]">⛩️</span>
            <h1 className="text-[1.15rem] font-mincho font-semibold tracking-wide mt-1">旅費帳本 雲端版</h1>
          </div>
          <div className="flex items-center gap-3">
            {/* 雲端同步狀態提示 */}
            {isSyncing ? (
              <span className="text-[#d4a017] text-[0.7rem] font-bold font-zen animate-pulse">⏳ 同步中</span>
            ) : SCRIPT_URL ? (
              <span className="text-[#27ae60] text-[0.7rem] font-bold font-zen">☁️ 雲端</span>
            ) : (
              <span className="text-[#8c7b6b] text-[0.7rem] font-bold font-zen">📱 本機</span>
            )}
            
            <div className="text-[#d4a017] text-[0.85rem] font-bold font-zen">
              💴 {settings.exchangeRate}
            </div>
          </div>
        </header>

        {tab === 'home' && renderHome()}
        {tab === 'list' && renderList()}
        {tab === 'analytics' && renderAnalytics()}
        {tab === 'settings' && renderSettings()}
      </div>

      {/* Bottom Navigation */}
      <nav className="absolute bottom-0 w-full bg-[#1a1209] flex z-20 pb-safe shadow-[0_-4px_20px_rgba(0,0,0,0.1)]">
        <NavItem icon="🏠" label="首頁" active={tab === 'home'} onClick={() => setTab('home')} />
        <NavItem icon="📋" label="明細" active={tab === 'list'} onClick={() => setTab('list')} />
        <NavItem icon="📊" label="分析" active={tab === 'analytics'} onClick={() => setTab('analytics')} />
        <NavItem icon="⚙️" label="設定" active={tab === 'settings'} onClick={() => setTab('settings')} />
      </nav>

      {/* Loading Overlay for Scanning */}
      {isScanning && (
        <div className="absolute inset-0 bg-black/85 z-50 flex flex-col items-center justify-center text-white font-zen gap-4 animate-in fade-in">
          <div className="w-10 h-10 border-4 border-[#333] border-t-[#d4a017] rounded-full animate-spin"></div>
          <div className="font-bold tracking-wide">🤖 {scanStatus}</div>
        </div>
      )}

      {/* Edit / Add Modal */}
      {isEditing && currentExpense && (
        <div className="absolute inset-0 bg-black/60 z-40 flex items-end justify-center animate-in fade-in" onClick={() => setIsEditing(false)}>
          <div className="bg-[#fffdf8] w-full max-w-md rounded-t-[20px] p-6 shadow-2xl animate-in slide-in-from-bottom-5 duration-300 font-zen" onClick={e => e.stopPropagation()}>
            <h3 className="mb-4 font-mincho font-bold text-lg text-[#1a1209]">
              {currentExpense.amountJpy === '' ? '📝 編輯紀錄' : '🤖 確認細項'}
            </h3>

            <div className="bg-[#f0e8d8] p-4 rounded-xl border border-[#d4c4a8] space-y-3 mb-5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[0.7rem] text-[#8c7b6b] mb-1 font-bold">日期</label>
                  <input type="date" value={currentExpense.date} onChange={e => setCurrentExpense({...currentExpense, date: e.target.value})} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#fffdf8] focus:outline-none focus:border-[#d4a017] text-sm" />
                </div>
                <div>
                  <label className="block text-[0.7rem] text-[#8c7b6b] mb-1 font-bold">類別</label>
                  <select value={currentExpense.category} onChange={e => setCurrentExpense({...currentExpense, category: e.target.value})} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#fffdf8] focus:outline-none focus:border-[#d4a017] text-sm">
                    {CATEGORIES.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[0.7rem] text-[#8c7b6b] mb-1 font-bold">名稱</label>
                <input type="text" value={currentExpense.name} onChange={e => setCurrentExpense({...currentExpense, name: e.target.value})} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#fffdf8] focus:outline-none focus:border-[#d4a017] text-sm" />
              </div>

              <div>
                <label className="block text-[0.7rem] text-[#8c7b6b] mb-1 font-bold">金額 (¥)</label>
                <input type="number" value={currentExpense.amountJpy} onChange={e => setCurrentExpense({...currentExpense, amountJpy: e.target.value})} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#fffdf8] focus:outline-none focus:border-[#d4a017] text-sm" />
              </div>

              <div>
                <label className="block text-[0.7rem] text-[#8c7b6b] mb-1 font-bold">備註 (選填)</label>
                <input type="text" value={currentExpense.note || ''} onChange={e => setCurrentExpense({...currentExpense, note: e.target.value})} className="w-full p-2 border border-[#d4c4a8] rounded-lg bg-[#fffdf8] focus:outline-none focus:border-[#d4a017] text-sm" />
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2">
              <button onClick={() => setIsEditing(false)} className="flex-1 bg-[#fffdf8] border border-[#d4c4a8] py-3 rounded-xl font-bold text-[#1a1209] shadow-sm">取消</button>
              <button onClick={handleSaveExpense} className="flex-[2] bg-[#c0392b] text-white py-3 rounded-xl font-bold shadow-sm">✅ 確認儲存</button>
            </div>
            
            {/* Delete button (only show if it already exists in expenses) */}
            {expenses.find(e => e.id === currentExpense.id) && (
              <button onClick={() => handleDeleteExpense(currentExpense.id)} className="w-full mt-4 py-2 text-[#c0392b] font-bold text-sm text-center opacity-80 hover:opacity-100">
                🗑️ 刪除此紀錄
              </button>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

// Navigation Item Component
const NavItem = ({ icon, label, active, onClick }) => (
  <button 
    onClick={onClick} 
    className={`flex-1 flex flex-col items-center gap-1 py-3 border-t-2 transition-colors ${active ? 'text-[#d4a017] border-[#d4a017]' : 'text-[#faf6ef]/50 border-transparent hover:text-[#faf6ef]/80'}`}
  >
    <div className="text-lg mb-0.5">{icon}</div>
    <span className="text-[0.7rem] font-bold font-zen tracking-wider">{label}</span>
  </button>
);
