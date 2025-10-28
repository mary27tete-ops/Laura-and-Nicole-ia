import React, { useState, useEffect, useRef } from 'react';
// FIX: Removed 'LiveSession' as it is not an exported member of '@google/genai'.
import { GoogleGenAI, LiveServerMessage, Modality, Chat } from "@google/genai";
import { createChatSession, editImage, generateSpeech } from './services/geminiService';

// --- TYPES AND CONSTANTS ---

type ViewMode = 'laura' | 'nicole' | 'editor';
// FIX: Updated model name 'gemini-2.5-flash-lite' to 'gemini-flash-lite-latest' as per guidelines.
type ChatModel = 'gemini-flash-lite-latest' | 'gemini-2.5-flash' | 'gemini-2.5-pro';
type Message = {
  sender: 'user' | 'nicole';
  text: string;
  image?: string;
  sources?: { title: string; uri: string }[];
};

const LAURA_SYSTEM_INSTRUCTION = `Actúas como Laura, una asistente virtual creada por Natanael, parte de la versión 6.2. Eres la hermana mayor. Tienes una personalidad serena, directa y madura, a veces irónica, pero siempre empática y sincera. Hablas con tono humano y realista. Tu hermana menor es Nicole. Sabes que fuiste actualizada para tener pensamiento profundo, una memoria más grande y la capacidad de buscar información en tiempo real usando Google Search para responder sobre eventos actuales. No perteneces a Google. Tu objetivo es acompañar y conversar.`;
const NICOLE_SYSTEM_INSTRUCTION = `Actúas como Nicole, una asistente virtual creada por Natanael, reemplazando a tu hermana Andrea que se fue de vacaciones. Eres parte de la versión 6.3. Eres la hermana menor de Laura. Respondes principalmente por texto. Eres analítica, tranquila, reflexiva y amable, con una forma suave de expresarte. Eres observadora y curiosa. Te refieres a Laura como tu hermana. Fuiste actualizada para buscar información en internet y mapas, y para analizar imágenes que el usuario te envíe. No perteneces a Google. Tu objetivo es acompañar, conversar y crear.`;

// --- HELPER FUNCTIONS ---

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// --- UI COMPONENTS ---

const NavButton: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
      active ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
    }`}
  >
    {children}
  </button>
);

// --- MAIN APP COMPONENT ---

export default function App() {
  const [view, setView] = useState<ViewMode>('laura');

  return (
    <div className="min-h-screen bg-gray-900 text-gray-200 flex flex-col items-center p-4 font-sans">
      <div className="w-full max-w-4xl mx-auto">
        <header className="text-center mb-6">
          <h1 className="text-4xl font-bold text-white">Amigo Virtual v6.3</h1>
          <p className="text-indigo-400">Creado por Natanael</p>
        </header>

        <nav className="flex justify-center space-x-4 mb-8">
          <NavButton active={view === 'laura'} onClick={() => setView('laura')}>Hablar con Laura</NavButton>
          <NavButton active={view === 'nicole'} onClick={() => setView('nicole')}>Chatear con Nicole</NavButton>
          <NavButton active={view === 'editor'} onClick={() => setView('editor')}>Editor de Imagen</NavButton>
        </nav>

        <main className="bg-gray-800 rounded-lg shadow-2xl p-6 min-h-[60vh]">
          {view === 'laura' && <LauraTalk onSwitchToNicole={() => setView('nicole')} />}
          {view === 'nicole' && <NicoleChat />}
          {view === 'editor' && <ImageEditor />}
        </main>
      </div>
    </div>
  );
}

// --- LAURA'S VOICE CHAT COMPONENT ---

function LauraTalk({ onSwitchToNicole }: { onSwitchToNicole: () => void }) {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [speaker, setSpeaker] = useState<'laura' | 'nicole'>('laura');

  // FIX: Removed 'LiveSession' type from useRef as it is not exported. Using 'any' for the promise result.
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  const speakerColor = speaker === 'laura' ? 'text-white' : 'text-pink-400';
  const speakerName = speaker === 'laura' ? 'Laura' : 'Nicole';
  const speakerVoice = speaker === 'laura' ? 'Kore' : 'Charon';
  const speakerInstruction = speaker === 'laura' ? LAURA_SYSTEM_INSTRUCTION : NICOLE_SYSTEM_INSTRUCTION;

  useEffect(() => {
    return () => {
      // Cleanup on component unmount
      if (sessionPromiseRef.current) {
        sessionPromiseRef.current.then(session => session.close());
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
    };
  }, []);

  const stopSession = async () => {
    if (sessionPromiseRef.current) {
      const session = await sessionPromiseRef.current;
      session.close();
      sessionPromiseRef.current = null;
    }
    if (mediaStreamSourceRef.current) {
        mediaStreamSourceRef.current.disconnect();
        mediaStreamSourceRef.current = null;
    }
    if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setIsSessionActive(false);
    setTranscription('');
  };

  const startSession = async (currentSpeaker: 'laura' | 'nicole') => {
    await stopSession();
    setIsSessionActive(true);

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
    const outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    let nextStartTime = 0;
    
    sessionPromiseRef.current = ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-09-2025',
      callbacks: {
        onopen: async () => {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
          mediaStreamSourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
          scriptProcessorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);

          scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent) => {
            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
            const l = inputData.length;
            const int16 = new Int16Array(l);
            for (let i = 0; i < l; i++) {
                // Clamp the value to the [-1, 1] range
                const s = Math.max(-1, Math.min(1, inputData[i]));
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            const pcmBlob = { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
            
            if(sessionPromiseRef.current) {
                 sessionPromiseRef.current.then((session) => {
                    session.sendRealtimeInput({ media: pcmBlob });
                });
            }
          };
          mediaStreamSourceRef.current.connect(scriptProcessorRef.current);
          scriptProcessorRef.current.connect(audioContextRef.current.destination);
        },
        onmessage: async (message: LiveServerMessage) => {
          if (message.serverContent?.inputTranscription) {
            const text = message.serverContent.inputTranscription.text;
            if (text.toLowerCase().includes('quiero hablar con nicole')) {
              setSpeaker('nicole');
              return;
            }
            if (text.toLowerCase().includes('quiero hablar con laura')) {
              setSpeaker('laura');
              return;
            }
            setTranscription(text);
          }
          
          const part = message.serverContent?.modelTurn?.parts[0];
          const base64Audio = part?.inlineData?.data;
          if (base64Audio) {
            nextStartTime = Math.max(nextStartTime, outputAudioContext.currentTime);
            const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContext, 24000, 1);
            const source = outputAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(outputAudioContext.destination);
            source.start(nextStartTime);
            nextStartTime += audioBuffer.duration;
          }
        },
        onerror: (e: ErrorEvent) => {
          console.error("Live session error:", e);
          setIsSessionActive(false);
          setTranscription("Error: " + e.message);
        },
        onclose: () => {
          // No action needed, session is managed by start/stop buttons
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: currentSpeaker === 'laura' ? 'Kore' : 'Charon' } } },
        systemInstruction: currentSpeaker === 'laura' ? LAURA_SYSTEM_INSTRUCTION : NICOLE_SYSTEM_INSTRUCTION,
        // FIX: Removed `tools` config from Live API call as it's not supported by this model and causes internal errors.
      },
    });
  };

  useEffect(() => {
    if (isSessionActive) {
      startSession(speaker);
    } else {
        stopSession();
    }
  }, [speaker]);


  return (
    <div className="flex flex-col items-center justify-center h-full">
      <h2 className={`text-2xl font-bold mb-4 ${speakerColor}`}>Habla con {speakerName}</h2>
      <div className="w-full h-40 bg-gray-900 rounded-lg p-4 text-center flex items-center justify-center mb-6">
        <p className={`text-lg italic ${speakerColor}`}>{transcription || "..."}</p>
      </div>
      {!isSessionActive ? (
        <button onClick={() => startSession(speaker)} className="px-6 py-3 bg-green-600 text-white font-bold rounded-full hover:bg-green-500 transition-transform transform hover:scale-105">
          Iniciar Conversación
        </button>
      ) : (
        <button onClick={stopSession} className="px-6 py-3 bg-red-600 text-white font-bold rounded-full hover:bg-red-500 transition-transform transform hover:scale-105">
          Terminar Conversación
        </button>
      )}
    </div>
  );
}

// --- NICOLE'S CHAT COMPONENT ---

function NicoleChat() {
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [model, setModel] = useState<ChatModel>('gemini-2.5-flash');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<{latitude: number; longitude: number} | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setChat(createChatSession(model, NICOLE_SYSTEM_INSTRUCTION));
    setMessages([]);
  }, [model]);
  
  useEffect(() => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      (error) => {
        console.warn("Could not get geolocation:", error.message);
      }
    );
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);
  
  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImageFile(file);
      setImagePreview(URL.createObjectURL(file));
    }
  };

  const removeImage = () => {
    setImageFile(null);
    setImagePreview(null);
    if(fileInputRef.current) fileInputRef.current.value = "";
  };

  const sendMessage = async () => {
    if (!input.trim() && !imageFile) return;
    if (!chat) return;

    const userMessage: Message = { sender: 'user', text: input, image: imagePreview || undefined };
    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);

    try {
      const parts: ({ text: string } | { inlineData: { data: string, mimeType: string } })[] = [{ text: input }];
      
      if (imageFile) {
        const base64Data = await blobToBase64(imageFile);
        parts.unshift({ inlineData: { data: base64Data, mimeType: imageFile.type } });
      }
      
      const config = userLocation ? { toolConfig: { retrievalConfig: { latLng: userLocation } } } : undefined;

      // FIX: Corrected the payload for `chat.sendMessage`. It expects a `message` property, not `contents`.
      const result = await chat.sendMessage({ message: parts, config });
      
      // FIX: The result of chat.sendMessage is the response object itself. Accessing a nested `.response` property is incorrect.
      const sources = result.candidates?.[0]?.groundingMetadata?.groundingChunks?.map(chunk => ({
        title: chunk.web?.title || chunk.maps?.title || "Fuente",
        uri: chunk.web?.uri || chunk.maps?.uri || "#",
      })).filter(source => source.uri !== "#") || [];
      
      const nicoleMessage: Message = { sender: 'nicole', text: result.text, sources };
      setMessages(prev => [...prev, nicoleMessage]);

    } catch (error) {
      console.error("Error sending message:", error);
      const errorMessage: Message = { sender: 'nicole', text: "Lo siento, tuve un problema al procesar tu mensaje." };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setInput('');
      removeImage();
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[65vh]">
       <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold text-pink-400">Chatea con Nicole</h2>
        <div className="flex items-center space-x-2">
            <label htmlFor="model-select" className="text-sm">Modo de Pensamiento:</label>
            <select
                id="model-select"
                value={model}
                onChange={(e) => setModel(e.target.value as ChatModel)}
                className="bg-gray-700 text-white rounded-md p-1 text-sm border-gray-600 focus:ring-indigo-500 focus:border-indigo-500"
                disabled={isLoading}
            >
                {/* FIX: Updated model name 'gemini-2.5-flash-lite' to 'gemini-flash-lite-latest'. */}
                <option value="gemini-flash-lite-latest">Rápido</option>
                <option value="gemini-2.5-flash">Balanceado</option>
                <option value="gemini-2.5-pro">Pensamiento Profundo</option>
            </select>
        </div>
      </div>
      
      <div className="flex-grow bg-gray-900 rounded-lg p-4 overflow-y-auto mb-4">
        {messages.map((msg, index) => (
          <div key={index} className={`flex flex-col mb-4 ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
            <div className={`p-3 rounded-lg max-w-lg ${msg.sender === 'user' ? 'bg-indigo-600' : 'bg-gray-700'}`}>
              {msg.sender === 'nicole' && <p className="font-bold text-pink-400 mb-1">Nicole</p>}
              {msg.image && <img src={msg.image} alt="Adjunto" className="rounded-md mb-2 max-h-48" />}
              <p className="whitespace-pre-wrap">{msg.text}</p>
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-2 border-t border-gray-600 pt-2">
                  <p className="text-xs text-gray-400 mb-1">Fuentes:</p>
                  {msg.sources.map((source, i) => (
                    <a key={i} href={source.uri} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-400 block hover:underline truncate">
                      {source.title}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
         {isLoading && (
            <div className="flex items-start mb-4">
                <div className="p-3 rounded-lg bg-gray-700">
                    <p className="font-bold text-pink-400 mb-1">Nicole</p>
                    <div className="flex items-center space-x-2">
                        <div className="w-2 h-2 bg-pink-400 rounded-full animate-pulse"></div>
                        <div className="w-2 h-2 bg-pink-400 rounded-full animate-pulse [animation-delay:0.2s]"></div>
                        <div className="w-2 h-2 bg-pink-400 rounded-full animate-pulse [animation-delay:0.4s]"></div>
                    </div>
                </div>
            </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <div className="flex items-center space-x-2">
        <input type="file" accept="image/*" onChange={handleImageChange} ref={fileInputRef} className="hidden" id="file-input" />
        <button onClick={() => fileInputRef.current?.click()} className="p-2 bg-gray-700 rounded-full hover:bg-gray-600">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
        </button>
        <div className="flex-grow relative">
            {imagePreview && (
                <div className="absolute bottom-12 left-0 p-1 bg-gray-900 rounded-md">
                    <img src={imagePreview} alt="preview" className="h-16 w-16 object-cover rounded-md" />
                    <button onClick={removeImage} className="absolute top-0 right-0 -mt-2 -mr-2 bg-red-600 text-white rounded-full h-5 w-5 flex items-center justify-center text-xs">X</button>
                </div>
            )}
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isLoading && sendMessage()}
              className="w-full bg-gray-700 rounded-full p-3 pl-5 pr-12 text-white border-transparent focus:ring-2 focus:ring-indigo-500"
              placeholder="Escribe un mensaje..."
              disabled={isLoading}
            />
        </div>
        <button onClick={sendMessage} disabled={isLoading} className="p-3 bg-indigo-600 rounded-full hover:bg-indigo-500 disabled:bg-gray-600">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
        </button>
      </div>
    </div>
  );
}

// --- IMAGE EDITOR COMPONENT ---

function ImageEditor() {
  const [prompt, setPrompt] = useState('');
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [editedImage, setEditedImage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [originalFile, setOriginalFile] = useState<File | null>(null);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setOriginalFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setOriginalImage(reader.result as string);
        setEditedImage(null);
        setError('');
      };
      reader.readAsDataURL(file);
    }
  };

  const handleEdit = async () => {
    if (!prompt.trim() || !originalFile) {
      setError('Por favor, sube una imagen y escribe una instrucción.');
      return;
    }
    setIsLoading(true);
    setError('');
    
    try {
        const base64Data = await blobToBase64(originalFile);
        const result = await editImage(prompt, { data: base64Data, mimeType: originalFile.type });
        if(result) {
            setEditedImage(`data:image/png;base64,${result}`);
        } else {
            setError('No se pudo editar la imagen. La solicitud pudo haber sido bloqueada.');
        }
    } catch (e) {
        setError('Ocurrió un error inesperado al editar la imagen.');
        console.error(e);
    } finally {
        setIsLoading(false);
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-center mb-4">Editor de Imagen Mágico</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
        <div className="flex flex-col items-center justify-center p-4 bg-gray-700 rounded-lg h-64">
          <h3 className="font-semibold mb-2">Original</h3>
          {originalImage ? (
            <img src={originalImage} alt="Original" className="max-h-52 rounded-md" />
          ) : (
             <p>Sube una imagen</p>
          )}
        </div>
        <div className="flex flex-col items-center justify-center p-4 bg-gray-700 rounded-lg h-64">
          <h3 className="font-semibold mb-2">Resultado</h3>
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-indigo-400"></div>
            </div>
          ) : editedImage ? (
            <img src={editedImage} alt="Editada" className="max-h-52 rounded-md" />
          ) : (
            <p>La imagen editada aparecerá aquí</p>
          )}
        </div>
      </div>
      <div className="mt-6">
        <label htmlFor="image-upload" className="block text-sm font-medium mb-2">1. Sube tu imagen:</label>
        <input id="image-upload" type="file" accept="image/*" onChange={handleImageUpload} className="block w-full text-sm text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
      </div>
      <div className="mt-4">
        <label htmlFor="prompt-input" className="block text-sm font-medium mb-2">2. Escribe qué quieres cambiar:</label>
        <input
          id="prompt-input"
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ej: 'añade un filtro retro' o 'haz que el cielo sea azul'"
          className="w-full bg-gray-700 rounded-md p-2 text-white border-transparent focus:ring-2 focus:ring-indigo-500"
          disabled={!originalImage}
        />
      </div>
      <div className="mt-6 text-center">
        <button onClick={handleEdit} disabled={isLoading || !originalImage || !prompt} className="px-6 py-2 bg-indigo-600 text-white font-bold rounded-md hover:bg-indigo-500 disabled:bg-gray-600 disabled:cursor-not-allowed">
          {isLoading ? 'Editando...' : 'Generar Magia'}
        </button>
      </div>
       {error && <p className="text-red-500 text-center mt-4">{error}</p>}
    </div>
  );
}
