// Importações de bibliotecas e hooks do React
import React, { useState, useEffect, createContext, useContext, useCallback } from 'react';

// Importações do Firebase SDK
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, onSnapshot, query, serverTimestamp, getDocs, doc, updateDoc, deleteDoc } from 'firebase/firestore';

// Importações de lógica de negócio e utilitários
import { calculateAbastecimento, calculatePremiacao } from './calculationLogic';
import { validateField, validateForm } from './validationUtils';
import { CONFIG } from './constants';
import { normalizeCityName, formatarCPF, parseCurrencyToNumber } from './dataUtils';

// =================================================================================
// CONTEXTOS GLOBAIS
// =================================================================================

// Contexto para instâncias do Firebase
const FirebaseContext = createContext(null);

// Contexto para dados da aplicação (veículos, motoristas, etc.) e estado global
const AppContext = createContext(null);

// =================================================================================
// HOOKS PERSONALIZADOS PARA FIREBASE
// =================================================================================

/**
 * Hook para inicializar o Firebase e gerenciar o estado de autenticação.
 * Retorna as instâncias do Firebase e o ID do usuário.
 */
const useFirebase = () => {
    const [firebaseInstances, setFirebaseInstances] = useState({ db: null, auth: null, userId: null, appId: null, isAuthReady: false });

    useEffect(() => {
        const initFirebase = async () => {
            try {
                // As variáveis __firebase_config e __app_id são injetadas pelo ambiente Canvas.
                // Para desenvolvimento local fora do Canvas, você pode definir um fallback.
                const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
                const currentAppId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

                if (!firebaseConfig || Object.keys(firebaseConfig).length === 0) {
                    console.error("Firebase: Configuração do Firebase está faltando ou vazia.");
                    setFirebaseInstances(prev => ({ ...prev, isAuthReady: true }));
                    return;
                }

                const app = initializeApp(firebaseConfig);
                const dbInstance = getFirestore(app);
                const authInstance = getAuth(app);

                onAuthStateChanged(authInstance, async (user) => {
                    let currentUserId = null;
                    if (user) {
                        currentUserId = user.uid;
                        console.log("Firebase: Usuário autenticado. User ID:", currentUserId);
                    } else {
                        console.log("Firebase: Nenhum usuário autenticado. Tentando autenticação anônima.");
                        try {
                            await signInAnonymously(authInstance);
                            // onAuthStateChanged será chamado novamente com o novo usuário anônimo.
                        } catch (error) {
                            console.error("Firebase: Erro na autenticação anônima:", error);
                        }
                    }
                    setFirebaseInstances({ db: dbInstance, auth: authInstance, userId: currentUserId, appId: currentAppId, isAuthReady: true });
                });

                // Se já houver um token de autenticação inicial (do Canvas), use-o.
                if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                    await signInWithCustomToken(authInstance, __initial_auth_token);
                } else {
                    // Se não houver token customizado, o onAuthStateChanged acima já tentará signInAnonymously.
                }

            } catch (error) {
                console.error("Firebase: Erro ao inicializar Firebase:", error);
                setFirebaseInstances(prev => ({ ...prev, isAuthReady: true })); // Marcar como pronto mesmo com erro
            }
        };

        initFirebase();
    }, []);

    return firebaseInstances;
};

/**
 * Hook para buscar dados de coleções públicas do Firestore.
 */
const useFirebaseData = (collectionName) => {
    const { db, appId, isAuthReady } = useContext(FirebaseContext);
    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!db || !appId || !isAuthReady) {
            if (isAuthReady) { // Se a autenticação falhou, mas o Firebase está "pronto"
                setError(new Error(`Firebase DB ou App ID não estão prontos para carregar dados de ${collectionName}.`));
                setLoading(false);
            }
            return;
        }

        const fetchData = async () => {
            setLoading(true);
            setError(null);
            try {
                const collectionPath = `artifacts/${appId}/public/data/${collectionName}`;
                const q = query(collection(db, collectionPath));
                const querySnapshot = await getDocs(q);
                const fetchedData = [];
                querySnapshot.forEach((d) => {
                    fetchedData.push({ id: d.id, ...d.data() });
                });
                setData(fetchedData);
            } catch (err) {
                console.error(`Erro ao carregar dados da coleção pública ${collectionName}:`, err);
                setError(err);
                setData([]); // Limpar dados em caso de erro
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, [db, appId, collectionName, isAuthReady]);

    return { data, loading, error };
};

/**
 * Hook para ouvir coleções específicas do usuário em tempo real.
 */
const useUserRecords = (collectionName) => {
    const { db, userId, appId, isAuthReady } = useContext(FirebaseContext);
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!db || !userId || !appId || !isAuthReady) {
            if (isAuthReady) { // Se a autenticação falhou, mas o Firebase está "pronto"
                setError(new Error(`Firebase DB, User ID ou App ID não estão prontos para ouvir registros de ${collectionName}.`));
                setLoading(false);
            }
            return;
        }

        setLoading(true);
        setError(null);

        const userSpecificCollectionPath = `artifacts/${appId}/users/${userId}/${collectionName}`;
        const q = query(collection(db, userSpecificCollectionPath));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const fetchedRecords = [];
            snapshot.forEach((doc) => {
                fetchedRecords.push({ id: doc.id, ...doc.data() });
            });
            // Ordena os registros pela data mais recente (dataRegistro é um Timestamp)
            fetchedRecords.sort((a, b) => (b.dataRegistro?.toDate() || 0) - (a.dataRegistro?.toDate() || 0));
            setRecords(fetchedRecords);
            setLoading(false);
        }, (err) => {
            console.error(`Erro ao ouvir registros de ${collectionName}:`, err);
            setError(err);
            setLoading(false);
            setRecords([]);
        });

        return () => unsubscribe(); // Limpar o listener ao desmontar o componente
    }, [db, userId, appId, collectionName, isAuthReady]);

    return { records, loading, error };
};

/**
 * Hook para operações de adição, atualização e exclusão no Firestore.
 */
const useFirestoreOperations = () => {
    const { db, userId, appId } = useContext(FirebaseContext);

    const addDocument = useCallback(async (collectionName, data) => {
        if (!db || !userId || !appId) {
            throw new Error("Firebase DB, User ID ou App ID não estão disponíveis.");
        }
        const userSpecificCollectionPath = `artifacts/${appId}/users/${userId}/${collectionName}`;
        const docRef = await addDoc(collection(db, userSpecificCollectionPath), {
            ...data,
            dataRegistro: serverTimestamp(),
            userId: userId
        });
        return docRef.id;
    }, [db, userId, appId]);

    const updateDocument = useCallback(async (collectionName, docId, data) => {
        if (!db || !userId || !appId) {
            throw new Error("Firebase DB, User ID ou App ID não estão disponíveis.");
        }
        const userSpecificDocPath = `artifacts/${appId}/users/${userId}/${collectionName}/${docId}`;
        await updateDoc(doc(db, userSpecificDocPath), {
            ...data,
            dataAtualizacao: serverTimestamp()
        });
    }, [db, userId, appId]);

    const deleteDocument = useCallback(async (collectionName, docId) => {
        if (!db || !userId || !appId) {
            throw new Error("Firebase DB, User ID ou App ID não estão disponíveis.");
        }
        const userSpecificDocPath = `artifacts/${appId}/users/${userId}/${collectionName}/${docId}`;
        await deleteDoc(doc(db, userSpecificDocPath));
    }, [db, userId, appId]);

    const addPublicBulkRecords = useCallback(async (collectionName, records) => {
        if (!db || !appId) {
            throw new Error("Firebase DB ou App ID não estão disponíveis para salvar dados públicos.");
        }
        const publicCollectionPath = `artifacts/${appId}/public/data/${collectionName}`;
        const promises = records.map(record => addDoc(collection(db, publicCollectionPath), record));
        await Promise.all(promises);
    }, [db, appId]);

    return { addDocument, updateDocument, deleteDocument, addPublicBulkRecords };
};

// =================================================================================
// COMPONENTES DE UI/FEEDBACK
// =================================================================================

/**
 * Componente Toast para notificações temporárias.
 */
const Toast = ({ message, type, onClose }) => {
    const [show, setShow] = useState(false);

    useEffect(() => {
        // Mostrar o toast com um pequeno atraso para a animação
        const timer1 = setTimeout(() => setShow(true), 50);
        // Esconder o toast após a duração
        const timer2 = setTimeout(() => {
            setShow(false);
            // Remover o toast do DOM após a animação de saída
            const timer3 = setTimeout(onClose, 400); // Duração da transição CSS
            return () => clearTimeout(timer3);
        }, 3000); // Duração padrão do toast

        return () => {
            clearTimeout(timer1);
            clearTimeout(timer2);
        };
    }, [onClose]);

    let bgColor = 'bg-blue-500';
    let icon = 'ℹ️';

    switch (type) {
        case 'success':
            bgColor = 'bg-green-500';
            icon = '✅';
            break;
        case 'error':
            bgColor = 'bg-red-500';
            icon = '❌';
            break;
        case 'warning':
            bgColor = 'bg-yellow-500';
            icon = '⚠️';
            break;
        default: // info
            bgColor = 'bg-blue-500';
            icon = 'ℹ️';
            break;
    }

    return (
        <div
            className={`${bgColor} text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 transition-all duration-300 ease-out transform ${show ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'}`}
            role="alert"
        >
            <span className="text-xl">{icon}</span>
            <span>{message}</span>
        </div>
    );
};

/**
 * Gerenciador de Toasts.
 */
const ToastContainer = () => {
    const [toasts, setToasts] = useState([]);

    const showToast = useCallback((message, type = 'info') => {
        const id = Date.now();
        setToasts(prevToasts => [...prevToasts, { id, message, type }]);
    }, []);

    const removeToast = useCallback((id) => {
        setToasts(prevToasts => prevToasts.filter(toast => toast.id !== id));
    }, []);

    // Expor a função showToast globalmente para uso fora do React (se necessário)
    useEffect(() => {
        window.showToast = showToast;
        return () => {
            delete window.showToast;
        };
    }, [showToast]);

    return (
        <div className="fixed top-4 right-4 z-[1001] flex flex-col space-y-3 pointer-events-none">
            {toasts.map(toast => (
                <Toast key={toast.id} message={toast.message} type={toast.type} onClose={() => removeToast(toast.id)} />
            ))}
        </div>
    );
};

/**
 * Componente Modal para confirmações e mensagens.
 */
const Modal = ({ title, message, type = 'info', onConfirm, onCancel, onClose }) => {
    const [show, setShow] = useState(false);

    useEffect(() => {
        setTimeout(() => setShow(true), 10); // Pequeno atraso para animação de entrada
    }, []);

    const handleClose = (result) => {
        setShow(false);
        setTimeout(() => {
            if (onClose) onClose(result);
            if (result && onConfirm) onConfirm();
            if (!result && onCancel) onCancel();
        }, 300); // Duração da transição de saída
    };

    let headerBg = 'bg-blue-600';
    let icon = 'ℹ️';
    let confirmBtnText = 'OK';
    let confirmBtnColor = 'bg-blue-600 hover:bg-blue-700';
    let showCancel = false;

    switch (type) {
        case 'success': headerBg = 'bg-green-600'; icon = '✅'; break;
        case 'error': headerBg = 'bg-red-600'; icon = '❌'; break;
        case 'warning': headerBg = 'bg-yellow-600'; icon = '⚠️'; confirmBtnColor = 'bg-yellow-600 hover:bg-yellow-700'; break;
        case 'confirm':
            headerBg = 'bg-indigo-600';
            icon = '❓';
            confirmBtnText = 'Confirmar';
            confirmBtnColor = 'bg-indigo-600 hover:bg-indigo-700';
            showCancel = true;
            break;
        default: // info
            headerBg = 'bg-blue-600';
            icon = 'ℹ️';
            break;
    }

    return (
        <div
            className={`fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-[1000] transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0'}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modalTitle"
            aria-describedby="modalMessage"
            onClick={(e) => { if (e.target === e.currentTarget && type !== 'confirm') handleClose(true); }}
        >
            <div
                className={`bg-white rounded-xl shadow-2xl w-11/12 max-w-md transform transition-transform duration-300 ${show ? 'translate-y-0' : '-translate-y-10'}`}
                onClick={e => e.stopPropagation()} // Evita fechar modal ao clicar dentro
            >
                <div className={`flex items-center justify-between p-4 ${headerBg} text-white rounded-t-xl`}>
                    <h3 id="modalTitle" className="text-xl font-semibold flex items-center gap-2">
                        <span className="text-2xl">{icon}</span> {title}
                    </h3>
                    {type !== 'confirm' && (
                        <button onClick={() => handleClose(true)} className="text-white text-2xl leading-none hover:opacity-75 transition-opacity" aria-label="Fechar">
                            &times;
                        </button>
                    )}
                </div>
                <div id="modalMessage" className="p-6 text-gray-700">
                    <p>{message}</p>
                </div>
                <div className="p-4 bg-gray-50 flex justify-end gap-3 rounded-b-xl">
                    {showCancel && (
                        <button
                            onClick={() => handleClose(false)}
                            className="px-5 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition-colors font-semibold shadow-md"
                        >
                            Cancelar
                        </button>
                    )}
                    <button
                        onClick={() => handleClose(true)}
                        className={`px-5 py-2 ${confirmBtnColor} text-white rounded-lg transition-colors font-semibold shadow-md`}
                    >
                        {confirmBtnText}
                    </button>
                </div>
            </div>
        </div>
    );
};

/**
 * Hook para gerenciar o estado de um modal.
 */
const useModal = () => {
    const [modalState, setModalState] = useState(null); // { title, message, type, resolve, reject }

    const showModal = useCallback((title, message, type = 'info') => {
        return new Promise((resolve, reject) => {
            setModalState({ title, message, type, resolve, reject });
        });
    }, []);

    const closeModal = useCallback((result) => {
        if (modalState) {
            modalState.resolve(result);
            setModalState(null);
        }
    }, [modalState]);

    return { showModal, closeModal, modalState };
};

/**
 * Componente de Spinner de Carregamento.
 */
const LoadingSpinner = ({ size = 'w-5 h-5', color = 'text-white' }) => (
    <div className={`inline-block ${size} border-2 border-solid border-current border-t-transparent rounded-full animate-spin ${color}`} role="status">
        <span className="sr-only">Carregando...</span>
    </div>
);

// =================================================================================
// COMPONENTES DE LAYOUT
// =================================================================================

/**
 * Componente Sidebar para navegação.
 */
const Sidebar = ({ activeSection, onNavigate, userId }) => {
    const navItems = [
        { id: 'abastecimento', label: '⛽ Abastecimento' },
        { id: 'premiacao', label: '🏆 Cálculo de Premiação' },
        { id: 'ajusteJornada', label: '⏰ Ajuste de Jornada' },
        { id: 'ocorrencias', label: '🚨 Controle de Ocorrências' },
        { id: 'historico', label: '📚 Histórico de Registros' },
        { id: 'dataManagement', label: '⚙️ Gerenciar Dados' },
    ];

    return (
        <aside className="w-72 bg-gray-900 text-white p-6 flex flex-col shadow-lg rounded-l-xl">
            <h2 className="text-3xl font-extrabold text-center mb-10 text-indigo-300">BWA Frota</h2>
            <nav className="flex-grow">
                <ul className="space-y-3">
                    {navItems.map(item => (
                        <li key={item.id}>
                            <button
                                onClick={() => onNavigate(item.id)}
                                className={`w-full flex items-center gap-4 px-6 py-3 rounded-lg text-lg font-medium transition-all duration-200
                                    ${activeSection === item.id ? 'bg-indigo-600 text-white shadow-md' : 'hover:bg-gray-700 text-gray-300 hover:text-white'}`}
                            >
                                {item.label}
                            </button>
                        </li>
                    ))}
                </ul>
            </nav>
            {userId && (
                <div className="mt-auto p-4 bg-gray-800 rounded-lg text-gray-400 text-sm break-words">
                    ID do Usuário: <span className="font-mono text-gray-300">{userId}</span>
                </div>
            )}
        </aside>
    );
};

/**
 * Componente Header para títulos de seção.
 */
const Header = ({ title, subtitle }) => (
    <div className="bg-gradient-to-r from-indigo-700 to-purple-800 text-white p-8 rounded-lg shadow-xl mb-8 text-center">
        <h1 className="text-4xl font-bold mb-2">{title}</h1>
        <p className="text-lg opacity-90">{subtitle}</p>
    </div>
);

// =================================================================================
// COMPONENTES DE SEÇÃO PRINCIPAIS
// =================================================================================

/**
 * Componente para a tela de boas-vindas.
 */
const WelcomeSection = ({ onNavigate }) => {
    const buttons = [
        { id: 'abastecimento', label: '⛽ Abastecimento' },
        { id: 'premiacao', label: '🏆 Cálculo de Premiação' },
        { id: 'ajusteJornada', label: '⏰ Ajuste de Jornada' },
        { id: 'ocorrencias', label: '🚨 Controle de Ocorrências' },
        { id: 'historico', label: '📚 Histórico de Registros' },
        { id: 'dataManagement', label: '⚙️ Gerenciar Dados' },
    ];

    return (
        <div className="flex flex-col items-center justify-center min-h-screen p-8 text-center bg-gray-50 rounded-xl shadow-inner">
            <h1 className="text-5xl font-extrabold text-gray-800 mb-6 animate-fade-in-down">Bem-vindo, BWA Transportes!</h1>
            <p className="text-xl text-gray-600 mb-12 animate-fade-in">Selecione uma funcionalidade para começar:</p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 w-full max-w-4xl animate-fade-in-up">
                {buttons.map(button => (
                    <button
                        key={button.id}
                        onClick={() => onNavigate(button.id)}
                        className="bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-bold py-5 px-8 rounded-xl shadow-lg hover:shadow-xl transform hover:-translate-y-1 transition-all duration-300 text-lg flex items-center justify-center gap-3"
                    >
                        {button.label}
                    </button>
                ))}
            </div>
        </div>
    );
};

/**
 * Componente para a seção de Gerenciamento de Dados.
 */
const DataManagementSection = () => {
    const { addPublicBulkRecords } = useFirestoreOperations();
    const { showToast } = useContext(AppContext);
    const [selectedFile, setSelectedFile] = useState(null);
    const [loading, setLoading] = useState(false);
    const [feedbackMessage, setFeedbackMessage] = useState(null);
    const [feedbackType, setFeedbackType] = useState(null);

    // Função para recarregar os dados públicos após o upload
    const { refreshData } = useContext(AppContext);

    const handleFileChange = (e) => {
        setSelectedFile(e.target.files[0]);
        setFeedbackMessage(null);
    };

    const handleUpload = async (e) => {
        e.preventDefault();
        if (!selectedFile) {
            setFeedbackMessage('Nenhum arquivo selecionado.');
            setFeedbackType('error');
            showToast('Selecione um arquivo JSON.', 'error');
            return;
        }

        setLoading(true);
        setFeedbackMessage('Iniciando upload...');
        setFeedbackType('info');

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const jsonContent = JSON.parse(event.target.result);

                const collectionsToUpload = {
                    'veiculos': jsonContent.veiculos,
                    'motoristas': jsonContent.motoristas,
                    'premiosFixosPorRota': jsonContent.premiosFixosPorRota,
                    'operadores': jsonContent.operadores
                };

                let uploadCount = 0;
                let errorCount = 0;
                let collectionsProcessed = 0;

                for (const collectionName in collectionsToUpload) {
                    const records = collectionsToUpload[collectionName];
                    if (Array.isArray(records) && records.length > 0) {
                        collectionsProcessed++;
                        setFeedbackMessage(`Carregando ${records.length} registros para "${collectionName}"...`);
                        setFeedbackType('info');
                        try {
                            // Normaliza nomes de cidades para premiosFixosPorRota antes de salvar
                            if (collectionName === 'premiosFixosPorRota') {
                                records.forEach(rota => {
                                    rota.origem = normalizeCityName(rota.origemDisplay);
                                    rota.destino = normalizeCityName(rota.destinoDisplay);
                                });
                            }
                            await addPublicBulkRecords(collectionName, records);
                            uploadCount += records.length;
                            showToast(`Coleção "${collectionName}" carregada.`, 'success');
                        } catch (error) {
                            console.error(`Erro ao salvar dados para ${collectionName}:`, error);
                            setFeedbackMessage(`Erro ao carregar dados para "${collectionName}". Verifique o console.`);
                            setFeedbackType('error');
                            errorCount += records.length;
                            showToast(`Erro ao carregar "${collectionName}".`, 'error');
                        }
                    } else {
                        showToast(`Coleção "${collectionName}" não encontrada ou vazia no JSON.`, 'info');
                    }
                }

                if (uploadCount > 0 && errorCount === 0) {
                    setFeedbackMessage(`Upload de dados concluído! ${uploadCount} registros processados em ${collectionsProcessed} coleções.`);
                    setFeedbackType('success');
                    showToast('Dados carregados com sucesso!', 'success');
                    refreshData(); // Recarregar dados globais do app
                } else if (uploadCount > 0 && errorCount > 0) {
                    setFeedbackMessage(`Upload de dados concluído com alguns erros. ${uploadCount} registros adicionados, ${errorCount} com falha.`);
                    setFeedbackType('warning');
                    showToast('Upload com alguns erros.', 'warning');
                } else {
                    setFeedbackMessage('Nenhum dado válido encontrado no arquivo JSON para upload.');
                    setFeedbackType('error');
                    showToast('Nenhum dado para upload.', 'error');
                }

            } catch (jsonError) {
                console.error("Erro ao parsear arquivo JSON:", jsonError);
                setFeedbackMessage('Erro ao ler o arquivo JSON. Certifique-se de que o formato esteja correto.');
                setFeedbackType('error');
                showToast('Erro de formato JSON.', 'error');
            } finally {
                setLoading(false);
                setSelectedFile(null); // Limpa o input do arquivo
                e.target.reset(); // Reseta o formulário para limpar o input file
            }
        };

        reader.onerror = (err) => {
            console.error("Erro ao ler o arquivo:", err);
            setFeedbackMessage('Erro ao ler o arquivo.');
            setFeedbackType('error');
            showToast('Erro de leitura de arquivo.', 'error');
            setLoading(false);
            setSelectedFile(null);
            e.target.reset();
        };

        reader.readAsText(selectedFile);
    };

    return (
        <section className="p-8 bg-white rounded-xl shadow-lg flex flex-col items-center">
            <Header title="⚙️ Gerenciamento de Dados" subtitle="Faça upload de arquivos JSON para popular as coleções estáticas do Firestore." />

            <div className="w-full max-w-2xl bg-gray-50 p-6 rounded-lg shadow-inner">
                <form onSubmit={handleUpload} className="space-y-6">
                    <div className="flex flex-col">
                        <label htmlFor="jsonFileUpload" className="text-lg font-semibold text-gray-700 mb-2">
                            ⬆️ Selecione o arquivo JSON de dados
                        </label>
                        <input
                            type="file"
                            id="jsonFileUpload"
                            accept=".json"
                            onChange={handleFileChange}
                            className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 cursor-pointer"
                        />
                    </div>
                    <button
                        type="submit"
                        className={`w-full bg-indigo-600 text-white font-bold py-3 px-6 rounded-lg shadow-md hover:bg-indigo-700 transition-colors duration-200 flex items-center justify-center gap-2 ${!selectedFile || loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                        disabled={!selectedFile || loading}
                    >
                        {loading && <LoadingSpinner />}
                        {loading ? 'Carregando Dados...' : '📥 Carregar Dados'}
                    </button>
                </form>

                {feedbackMessage && (
                    <div className={`mt-6 p-4 rounded-lg flex items-center gap-3 ${feedbackType === 'success' ? 'bg-green-100 text-green-800 border border-green-200' : feedbackType === 'error' ? 'bg-red-100 text-red-800 border border-red-200' : 'bg-blue-100 text-blue-800 border border-blue-200'}`}>
                        <span className="text-xl">
                            {feedbackType === 'success' ? '✅' : feedbackType === 'error' ? '❌' : 'ℹ️'}
                        </span>
                        <span>{feedbackMessage}</span>
                    </div>
                )}

                <div className="mt-8 p-6 bg-gray-100 rounded-lg border border-gray-200 text-gray-700 text-sm">
                    <h3 className="text-lg font-semibold text-center mb-4">Estrutura do Arquivo JSON Esperada:</h3>
                    <pre className="bg-gray-200 p-4 rounded-md overflow-auto text-xs md:text-sm font-mono whitespace-pre-wrap break-words">
                        <code>
{`{
  "veiculos": [
    { "placa": "ABC1D23", "modelo": "VOLVO FH 540", "ano": 2022, "tanque": 800, "tipo": "carreta" },
    // ... outros veículos
  ],
  "motoristas": [
    { "nome": "ADAELSON DA SILVA SANTOS", "cpf": "14011688762", "cidade": "Duque de Caxias", "estado": "RJ" },
    // ... outros motoristas
  ],
  "premiosFixosPorRota": [
    { "tipoOperacao": "CHEIO", "origemDisplay": "RIO DE JANEIRO", "destinoDisplay": "RESENDE", "kmReferencia": 272, "valorAbaixoMedia": 27.20, "valorAcimaMedia": 68.00 },
    // ... outras rotas
  ],
  "operadores": [
    { "nome": "OPERADOR A" },
    // ... outros operadores
  ]
}`}
                        </code>
                    </pre>
                    <p className="mt-4 text-gray-600 flex items-start gap-2">
                        <span className="text-xl">ℹ️</span>
                        <span>
                            Para evitar duplicidade, este upload **adicionará** novos registros. Se precisar substituir dados existentes,
                            o Firebase CLI ou a edição manual no console ainda são recomendados para tal precisão.
                        </span>
                    </p>
                </div>
            </div>
        </section>
    );
};


// =================================================================================
// COMPONENTES DE FORMULÁRIO
// =================================================================================

/**
 * Componente de formulário genérico para inputs.
 */
const FormField = ({ id, label, type = 'text', placeholder, value, onChange, required = false, min, max, step, disabled = false, readOnly = false, className = '' }) => {
    const [error, setError] = useState('');

    const handleBlur = (e) => {
        const isValid = validateField(e.target);
        setError(isValid ? '' : e.target.validationMessage || 'Valor inválido.');
    };

    const handleChange = (e) => {
        onChange(e);
        // Limpar erro ao digitar, mas manter no blur
        if (error) {
            const isValid = validateField(e.target);
            setError(isValid ? '' : e.target.validationMessage || 'Valor inválido.');
        }
    };

    const inputClasses = `w-full p-3 border-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300 transition-all duration-200 ${error ? 'border-red-500' : 'border-gray-300'} ${readOnly ? 'bg-gray-100 text-gray-600 cursor-not-allowed' : 'bg-white'}`;

    return (
        <div className={`mb-5 ${className}`}>
            <label htmlFor={id} className="block text-gray-700 text-base font-semibold mb-2">
                {label} {required && <span className="text-red-500">*</span>}
            </label>
            {type === 'select' ? (
                <select
                    id={id}
                    value={value}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    required={required}
                    disabled={disabled}
                    className={inputClasses}
                >
                    {/* Options são passadas como children */}
                </select>
            ) : type === 'textarea' ? (
                <textarea
                    id={id}
                    value={value}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    required={required}
                    placeholder={placeholder}
                    rows="4"
                    readOnly={readOnly}
                    disabled={disabled}
                    className={inputClasses}
                ></textarea>
            ) : (
                <input
                    type={type}
                    id={id}
                    value={value}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    required={required}
                    placeholder={placeholder}
                    min={min}
                    max={max}
                    step={step}
                    readOnly={readOnly}
                    disabled={disabled}
                    className={inputClasses}
                />
            )}
            {error && <p className="text-red-500 text-sm mt-1">{error}</p>}
        </div>
    );
};

/**
 * Componente para o formulário de Abastecimento.
 */
const AbastecimentoForm = () => {
    const { appData } = useContext(AppContext);
    const { addDocument } = useFirestoreOperations();
    const { showToast } = useContext(AppContext);

    const [formData, setFormData] = useState({
        origemDestino: '',
        placa: '',
        motorista: '',
        combRestante: '',
        kmCarregado: '',
        kmVazio: '',
    });
    const [selectedVehicle, setSelectedVehicle] = useState(null);
    const [selectedDriver, setSelectedDriver] = useState(null);
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [formError, setFormError] = useState('');

    const handleInputChange = (e) => {
        const { id, value } = e.target;
        setFormData(prev => ({ ...prev, [id]: value }));
        setFormError(''); // Limpa o erro geral do formulário ao digitar
        setResult(null); // Limpa o resultado ao digitar
    };

    const handleVehicleChange = (e) => {
        const placa = e.target.value;
        const vehicle = appData.veiculos.find(v => v.placa === placa);
        setSelectedVehicle(vehicle);
        setFormData(prev => ({ ...prev, placa }));
        setFormError('');
        setResult(null);
    };

    const handleDriverChange = (e) => {
        const nome = e.target.value;
        const driver = appData.motoristas.find(m => m.nome === nome);
        setSelectedDriver(driver);
        setFormData(prev => ({ ...prev, motorista: nome }));
        setFormError('');
        setResult(null);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setFormError('');
        setResult(null);

        const formElement = e.target;
        let isValid = validateForm(formElement);

        // Validação específica para KM
        const kmCarregadoValue = parseFloat(formData.kmCarregado) || 0;
        const kmVazioValue = parseFloat(formData.kmVazio) || 0;

        if (kmCarregadoValue === 0 && kmVazioValue === 0) {
            isValid = false;
            setFormError('Informe pelo menos um dos percursos (carregado ou vazio).');
            showToast('Informe os KMs percorridos.', 'error');
        }

        if (!isValid) {
            setLoading(false);
            showToast('Preencha todos os campos obrigatórios corretamente.', 'error');
            return;
        }

        try {
            if (!selectedVehicle) {
                setFormError('Veículo selecionado não encontrado.');
                showToast('Erro: Veículo não encontrado.', 'error');
                setLoading(false);
                return;
            }

            const dadosCalculo = {
                origemDestino: formData.origemDestino,
                placa: formData.placa,
                motorista: formData.motorista,
                tipo: selectedVehicle.tipo, // Usa o tipo do veículo selecionado
                kmCarregado: kmCarregadoValue,
                kmVazio: kmVazioValue,
                combRestante: parseFloat(formData.combRestante),
            };

            const calculationResult = calculateAbastecimento(dadosCalculo, selectedVehicle);
            setResult(calculationResult);

            await addDocument('abastecimentos', {
                origemDestino: dadosCalculo.origemDestino,
                placaVeiculo: dadosCalculo.placa,
                modeloVeiculo: selectedVehicle.modelo,
                motorista: dadosCalculo.motorista,
                tipoVeiculo: calculationResult.tipoCalculado,
                kmCarregado: dadosCalculo.kmCarregado,
                kmVazio: dadosCalculo.kmVazio,
                combustivelRestantePercent: dadosCalculo.combRestante,
                litrosCalculados: calculationResult.litrosTotais,
                necessitaAbastecer: calculationResult.precisaAbastecer,
                litrosExtrasNecessarios: calculationResult.litrosExtras,
            });

            showToast('Registro de abastecimento salvo!', 'success');
            // Limpa o formulário após o sucesso
            setFormData({
                origemDestino: '',
                placa: '',
                motorista: '',
                combRestante: '',
                kmCarregado: '',
                kmVazio: '',
            });
            setSelectedVehicle(null);
            setSelectedDriver(null);

        } catch (error) {
            console.error('Erro no abastecimento:', error);
            setFormError('Erro ao salvar registro de abastecimento. Tente novamente.');
            showToast('Erro ao salvar abastecimento.', 'error');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="p-8 bg-white rounded-xl shadow-lg flex flex-col items-center">
            <Header title="🚛 Calculadora de Combustível" subtitle="Sistema inteligente para cálculo de consumo da frota" />

            <div className="w-full max-w-3xl bg-gray-50 p-6 rounded-lg shadow-inner">
                <form onSubmit={handleSubmit} className="space-y-6">
                    <FormField
                        id="origemDestino"
                        label="📍 Origem / Destino da Rota"
                        placeholder="Ex: Rio de Janeiro-RJ x Santos-SP"
                        value={formData.origemDestino}
                        onChange={handleInputChange}
                        required
                    />

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <FormField
                            id="placa"
                            label="🚚 Selecione o Veículo"
                            type="select"
                            value={formData.placa}
                            onChange={handleVehicleChange}
                            required
                        >
                            <option value="">-- Selecione um veículo --</option>
                            {appData.veiculos.map(v => (
                                <option key={v.placa} value={v.placa}>
                                    {v.placa} - {v.modelo} ({v.ano})
                                </option>
                            ))}
                        </FormField>

                        <FormField
                            id="motorista"
                            label="👨‍✈️ Selecione o Motorista"
                            type="select"
                            value={formData.motorista}
                            onChange={handleDriverChange}
                            required
                        >
                            <option value="">-- Selecione um motorista --</option>
                            {appData.motoristas.map(m => (
                                <option key={m.cpf} value={m.nome}>
                                    {m.nome}
                                </option>
                            ))}
                        </FormField>
                    </div>

                    {selectedVehicle && (
                        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-green-800 text-sm shadow-sm">
                            <strong className="font-semibold">Informações do Veículo:</strong><br />
                            Modelo: {selectedVehicle.modelo}<br />
                            Ano: {selectedVehicle.ano}<br />
                            Capacidade do Tanque: {selectedVehicle.tanque}L<br />
                            Tipo: {selectedVehicle.tipo.charAt(0).toUpperCase() + selectedVehicle.tipo.slice(1)}
                        </div>
                    )}
                    {selectedDriver && (
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-blue-800 text-sm shadow-sm">
                            <strong className="font-semibold">Informações do Motorista:</strong><br />
                            CPF: {formatarCPF(selectedDriver.cpf)}<br />
                            Cidade: {selectedDriver.cidade}<br />
                            Estado: {selectedDriver.estado}
                        </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <FormField
                            id="tipoVeiculoDisplay"
                            label="⚙️ Tipo de Veículo"
                            type="text"
                            value={selectedVehicle ? selectedVehicle.tipo.charAt(0).toUpperCase() + selectedVehicle.tipo.slice(1) : '-- Selecione um veículo --'}
                            readOnly
                            disabled
                        />
                        <FormField
                            id="combRestante"
                            label="⛽ Combustível Restante no Tanque (%)"
                            type="number"
                            placeholder="Informe % de combustível restante"
                            value={formData.combRestante}
                            onChange={handleInputChange}
                            required
                            min="0"
                            max="100"
                            step="0.01"
                        />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <FormField
                            id="kmCarregado"
                            label="📦 KM Percorrido Carregado"
                            type="number"
                            placeholder="Informe KM carregado"
                            value={formData.kmCarregado}
                            onChange={handleInputChange}
                            min="0"
                            step="0.01"
                        />
                        <FormField
                            id="kmVazio"
                            label="📭 KM Percorrido Vazio"
                            type="number"
                            placeholder="Informe KM vazio"
                            value={formData.kmVazio}
                            onChange={handleInputChange}
                            min="0"
                            step="0.01"
                        />
                    </div>

                    {formError && (
                        <div className="bg-red-100 text-red-700 p-3 rounded-lg border border-red-200 text-sm">
                            {formError}
                        </div>
                    )}

                    <button
                        type="submit"
                        className="w-full bg-indigo-600 text-white font-bold py-3 px-6 rounded-lg shadow-md hover:bg-indigo-700 transition-colors duration-200 flex items-center justify-center gap-2"
                        disabled={loading}
                    >
                        {loading && <LoadingSpinner />}
                        {loading ? 'Calculando...' : '🧮 Calcular Consumo'}
                    </button>
                </form>

                {result && (
                    <div className="mt-8 p-6 bg-white rounded-lg shadow-md border-t-4 border-indigo-500 animate-fade-in">
                        <h2 className="text-2xl font-bold text-gray-800 mb-4 text-center">📊 Resultado da Rota: {formData.origemDestino}</h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-gray-700">
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Veículo:</p>
                                <p>{selectedVehicle.placa} - {selectedVehicle.modelo}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Tipo:</p>
                                <p>{result.tipoCalculado.charAt(0).toUpperCase() + result.tipoCalculado.slice(1)}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Capacidade do Tanque:</p>
                                <p>{selectedVehicle.tanque}L</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Combustível Disponível:</p>
                                <p>{result.litrosDisponiveis.toFixed(1)}L ({formData.combRestante}%)</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Consumo Estimado:</p>
                                <p>{result.litrosTotais.toFixed(1)}L</p>
                            </div>
                            {result.tipoCalculado !== 'almoxarifado bwa' && (
                                <div className="p-3 bg-gray-50 rounded-md">
                                    <p className="font-semibold">Capacidade Útil:</p>
                                    <p>{result.tanqueUtilizavel}L</p>
                                </div>
                            )}
                        </div>

                        {result.tipoCalculado === 'almoxarifado bwa' ? (
                            <div className="mt-6 p-4 bg-blue-100 text-blue-800 rounded-lg flex items-center gap-3 border border-blue-200">
                                <span className="text-2xl">ℹ️</span>
                                <div>
                                    <strong className="font-semibold">Este veículo é de Almoxarifado BWA.</strong><br />
                                    Não é necessário cálculo de combustível para este tipo de veículo.
                                </div>
                            </div>
                        ) : result.precisaAbastecer ? (
                            <div className="mt-6 p-4 bg-yellow-100 text-yellow-800 rounded-lg flex items-center gap-3 border border-yellow-200">
                                <span className="text-2xl">⚠️</span>
                                <div>
                                    <strong className="font-semibold">Abastecimento Necessário!</strong><br />
                                    O motorista precisará abastecer <strong className="font-bold">{result.litrosExtras.toFixed(1)} litros</strong>
                                    de diesel durante a rota.
                                </div>
                            </div>
                        ) : (
                            <div className="mt-6 p-4 bg-green-100 text-green-800 rounded-lg flex items-center gap-3 border border-green-200">
                                <span className="text-2xl">✅</span>
                                <div>
                                    <strong className="font-semibold">Combustível Suficiente!</strong><br />
                                    Não é necessário abastecimento. Sobrarão aproximadamente
                                    <strong className="font-bold">{(result.litrosDisponiveis - result.litrosTotais).toFixed(1)} litros</strong> no tanque.
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

/**
 * Componente para o formulário de Premiação.
 */
const PremiacaoForm = () => {
    const { appData } = useContext(AppContext);
    const { addDocument } = useFirestoreOperations();
    const { showToast } = useContext(AppContext);

    const [formData, setFormData] = useState({
        motorista: '',
        tipoOperacao: '',
        origemCarga: '',
        finalCarga: '',
        quilometragem: '',
        atingiuMedia: null, // 'sim' ou 'nao'
    });
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [formError, setFormError] = useState('');

    const handleInputChange = (e) => {
        const { id, value, name, type, checked } = e.target;
        setFormData(prev => ({
            ...prev,
            [name || id]: type === 'radio' ? (checked ? value : prev[name || id]) : value
        }));
        setFormError('');
        setResult(null);
    };

    const handleTypeOperationChange = (e) => {
        setFormData(prev => ({
            ...prev,
            tipoOperacao: e.target.value,
            origemCarga: '', // Reset origem
            finalCarga: '',  // Reset destino
            quilometragem: '', // Reset quilometragem
        }));
        setFormError('');
        setResult(null);
    };

    const handleOriginChange = (e) => {
        setFormData(prev => ({
            ...prev,
            origemCarga: e.target.value,
            finalCarga: '', // Reset destino
            quilometragem: '', // Reset quilometragem
        }));
        setFormError('');
        setResult(null);
    };

    const handleDestinationChange = (e) => {
        const destino = e.target.value;
        const rotaEncontrada = appData.premiosFixosPorRota.find(p =>
            p.tipoOperacao === formData.tipoOperacao &&
            normalizeCityName(p.origemDisplay) === normalizeCityName(formData.origemCarga) &&
            normalizeCityName(p.destinoDisplay) === normalizeCityName(destino)
        );
        setFormData(prev => ({
            ...prev,
            finalCarga: destino,
            quilometragem: rotaEncontrada ? rotaEncontrada.kmReferencia.toFixed(0) : '',
        }));
        setFormError('');
        setResult(null);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setFormError('');
        setResult(null);

        const formElement = e.target;
        let isValid = validateForm(formElement);

        // Validação específica para quilometragem
        if (isNaN(parseFloat(formData.quilometragem)) || parseFloat(formData.quilometragem) <= 0) {
            isValid = false;
            setFormError('A quilometragem da rota é obrigatória e deve ser um número positivo.');
            showToast('Quilometragem inválida.', 'error');
        }

        if (!isValid) {
            setLoading(false);
            showToast('Preencha todos os campos obrigatórios corretamente.', 'error');
            return;
        }

        try {
            const rotaEncontrada = appData.premiosFixosPorRota.find(p =>
                p.tipoOperacao === formData.tipoOperacao &&
                normalizeCityName(p.origemDisplay) === normalizeCityName(formData.origemCarga) &&
                normalizeCityName(p.destinoDisplay) === normalizeCityName(formData.finalCarga)
            );

            if (!rotaEncontrada) {
                setFormError(`Rota de premiação não encontrada para: ${formData.origemCarga} para ${formData.finalCarga} (${formData.tipoOperacao}).`);
                showToast('Erro: Rota não encontrada.', 'error');
                setLoading(false);
                return;
            } else if (isNaN(rotaEncontrada.kmReferencia) || isNaN(rotaEncontrada.valorAbaixoMedia) || isNaN(rotaEncontrada.valorAcimaMedia)) {
                setFormError(`Dados de premiação incompletos para a rota selecionada.`);
                showToast('Erro: Dados de premiação incompletos.', 'error');
                setLoading(false);
                return;
            }

            const dadosCalculo = {
                motorista: formData.motorista,
                tipoOperacao: formData.tipoOperacao,
                origemCarga: formData.origemCarga,
                finalCarga: formData.finalCarga,
                quilometragem: parseFloat(formData.quilometragem),
                atingiuMedia: formData.atingiuMedia === 'sim',
            };

            const calculationResult = calculatePremiacao(dadosCalculo, appData.premiosFixosPorRota);
            setResult(calculationResult);

            await addDocument('premiacoes', {
                motorista: dadosCalculo.motorista,
                tipoOperacao: calculationResult.tipoOperacao,
                origemCarga: calculationResult.origemDisplay,
                finalCarga: calculationResult.destinoDisplay,
                quilometragemInformada: dadosCalculo.quilometragem,
                kmReferenciaDaRota: calculationResult.kmReferenciaDaRota,
                valorTotalPremio: calculationResult.valorTotalPremio,
                atingiuMedia: calculationResult.atingiuMedia,
                situacaoMedia: calculationResult.situacaoMedia
            });

            showToast('Registro de premiação salvo!', 'success');
            // Limpa o formulário
            setFormData({
                motorista: '',
                tipoOperacao: '',
                origemCarga: '',
                finalCarga: '',
                quilometragem: '',
                atingiuMedia: null,
            });
            // Resetar radio buttons
            const radioAtingiuMediaSim = document.getElementById('atingiuMediaSim');
            const radioAtingiuMediaNao = document.getElementById('atingiuMediaNao');
            if (radioAtingiuMediaSim) radioAtingiuMediaSim.checked = false;
            if (radioAtingiuMediaNao) radioAtingiuMediaNao.checked = false;

        } catch (error) {
            console.error('Erro no cálculo da premiação:', error);
            setFormError('Erro ao salvar registro de premiação. Tente novamente.');
            showToast('Erro ao salvar premiação.', 'error');
        } finally {
            setLoading(false);
        }
    };

    const tiposOperacao = [...new Set(appData.premiosFixosPorRota.map(p => p.tipoOperacao))].sort();
    const origensFiltradas = [...new Set(appData.premiosFixosPorRota
        .filter(p => p.tipoOperacao === formData.tipoOperacao)
        .map(p => p.origemDisplay))].sort();
    const destinosFiltrados = [...new Set(appData.premiosFixosPorRota
        .filter(p => p.tipoOperacao === formData.tipoOperacao && normalizeCityName(p.origemDisplay) === normalizeCityName(formData.origemCarga))
        .map(p => p.destinoDisplay))].sort();

    const rotaAtual = appData.premiosFixosPorRota.find(p =>
        p.tipoOperacao === formData.tipoOperacao &&
        normalizeCityName(p.origemDisplay) === normalizeCityName(formData.origemCarga) &&
        normalizeCityName(p.destinoDisplay) === normalizeCityName(formData.finalCarga)
    );

    return (
        <div className="p-8 bg-white rounded-xl shadow-lg flex flex-col items-center">
            <Header title="🏆 Cálculo de Premiação" subtitle="Gerencie as premiações e reconhecimentos dos motoristas da frota." />

            <div className="w-full max-w-3xl bg-gray-50 p-6 rounded-lg shadow-inner">
                <form onSubmit={handleSubmit} className="space-y-6">
                    <FormField
                        id="motorista"
                        label="👨‍✈️ Selecione o Motorista"
                        type="select"
                        value={formData.motorista}
                        onChange={handleInputChange}
                        required
                    >
                        <option value="">-- Selecione um motorista --</option>
                        {appData.motoristas.map(m => (
                            <option key={m.cpf} value={m.nome}>
                                {m.nome}
                            </option>
                        ))}
                    </FormField>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <FormField
                            id="tipoOperacao"
                            label="📊 Tipo de Operação"
                            type="select"
                            value={formData.tipoOperacao}
                            onChange={handleTypeOperationChange}
                            required
                        >
                            <option value="">-- Selecione o tipo --</option>
                            {tiposOperacao.map(tipo => (
                                <option key={tipo} value={tipo}>
                                    {tipo === 'AP' ? 'APROVEITAMENTO' : 'CHEIO'}
                                </option>
                            ))}
                        </FormField>
                        <FormField
                            id="origemCarga"
                            label="📍 Início (Local de Origem da Carga)"
                            type="select"
                            value={formData.origemCarga}
                            onChange={handleOriginChange}
                            required
                            disabled={!formData.tipoOperacao}
                        >
                            <option value="">-- Selecione a origem --</option>
                            {origensFiltradas.map(origem => (
                                <option key={origem} value={origem}>
                                    {origem}
                                </option>
                            ))}
                        </FormField>
                    </div>

                    <FormField
                        id="finalCarga"
                        label="🏁 Fim (Local Final da Carga)"
                        type="select"
                        value={formData.finalCarga}
                        onChange={handleDestinationChange}
                        required
                        disabled={!formData.origemCarga}
                    >
                        <option value="">-- Selecione o destino --</option>
                        {destinosFiltrados.map(destino => (
                            <option key={destino} value={destino}>
                                {destino}
                            </option>
                        ))}
                    </FormField>

                    <FormField
                        id="quilometragem"
                        label="🛣️ Quilometragem (KM) Percorrida (Nesta Viagem)"
                        type="number"
                        value={formData.quilometragem}
                        readOnly
                        disabled
                        className="bg-gray-100 text-gray-600"
                    />
                    {rotaAtual && (
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-blue-800 text-sm shadow-sm">
                            <strong className="font-semibold">Valores Fixos da Rota:</strong><br />
                            KM de Referência: {rotaAtual.kmReferencia.toFixed(0)} KM<br />
                            Valor Abaixo da Média: R$ {rotaAtual.valorAbaixoMedia.toFixed(2).replace('.', ',')}<br />
                            Valor Acima da Média: R$ {rotaAtual.valorAcimaMedia.toFixed(2).replace('.', ',')}
                        </div>
                    )}

                    <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-5 text-gray-700">
                        <p className="text-lg font-semibold text-center mb-4">O motorista atingiu a média? <span className="text-red-500">*</span></p>
                        <div className="flex justify-center gap-8">
                            <label htmlFor="atingiuMediaSim" className="flex items-center cursor-pointer text-base font-medium">
                                <input
                                    type="radio"
                                    id="atingiuMediaSim"
                                    name="atingiuMedia"
                                    value="sim"
                                    checked={formData.atingiuMedia === 'sim'}
                                    onChange={handleInputChange}
                                    required
                                    className="mr-2 h-5 w-5 text-indigo-600 border-gray-300 focus:ring-indigo-500"
                                /> Sim
                            </label>
                            <label htmlFor="atingiuMediaNao" className="flex items-center cursor-pointer text-base font-medium">
                                <input
                                    type="radio"
                                    id="atingiuMediaNao"
                                    name="atingiuMedia"
                                    value="nao"
                                    checked={formData.atingiuMedia === 'nao'}
                                    onChange={handleInputChange}
                                    required
                                    className="mr-2 h-5 w-5 text-indigo-600 border-gray-300 focus:ring-indigo-500"
                                /> Não
                            </label>
                        </div>
                    </div>

                    {formError && (
                        <div className="bg-red-100 text-red-700 p-3 rounded-lg border border-red-200 text-sm">
                            {formError}
                        </div>
                    )}

                    <button
                        type="submit"
                        className="w-full bg-indigo-600 text-white font-bold py-3 px-6 rounded-lg shadow-md hover:bg-indigo-700 transition-colors duration-200 flex items-center justify-center gap-2"
                        disabled={loading}
                    >
                        {loading && <LoadingSpinner />}
                        {loading ? 'Gerando registro...' : 'Gerar registro de Premiação'}
                    </button>
                </form>

                {result && (
                    <div className="mt-8 p-6 bg-white rounded-lg shadow-md border-t-4 border-indigo-500 animate-fade-in">
                        <h2 className="text-2xl font-bold text-gray-800 mb-4 text-center">💰 Resultado do Cálculo de Premiação</h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-gray-700">
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Motorista:</p>
                                <p>{result.motorista}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Tipo de Operação:</p>
                                <p>{result.tipoOperacao}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Origem da Carga:</p>
                                <p>{result.origemDisplay}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Destino da Carga:</p>
                                <p>{result.destinoDisplay}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">KM de Referência da Rota:</p>
                                <p>{result.kmReferenciaDaRota} KM</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Situação da Premiação:</p>
                                <p>{result.situacaoMedia}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md col-span-full">
                                <p className="font-semibold">Valor Total da Premiação:</p>
                                <p className="text-2xl font-bold text-green-700">R$ {result.valorTotalPremio.toFixed(2).replace('.', ',')}</p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

/**
 * Componente para o formulário de Ajuste de Jornada.
 */
const AjusteJornadaForm = () => {
    const { appData } = useContext(AppContext);
    const { addDocument } = useFirestoreOperations();
    const { showToast } = useContext(AppContext);

    const [formData, setFormData] = useState({
        nomeOperador: '',
        motorista: '',
        ajusteJornadaTipo: '',
        dataHoraOcorrencia: '',
        placaVeiculo: '',
        motivoAjuste: '',
    });
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [formError, setFormError] = useState('');

    const handleInputChange = (e) => {
        const { id, value } = e.target;
        setFormData(prev => ({ ...prev, [id]: value }));
        setFormError('');
        setResult(null);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setFormError('');
        setResult(null);

        const formElement = e.target;
        let isValid = validateForm(formElement);

        if (!isValid) {
            setLoading(false);
            showToast('Preencha todos os campos obrigatórios corretamente.', 'error');
            return;
        }

        try {
            await addDocument('ajustesJornada', {
                nomeOperador: formData.nomeOperador,
                motorista: formData.motorista,
                ajusteJornadaTipo: formData.ajusteJornadaTipo,
                dataHoraOcorrencia: new Date(formData.dataHoraOcorrencia),
                placaVeiculo: formData.placaVeiculo,
                motivoAjuste: formData.motivoAjuste,
            });

            setResult(formData); // Para exibir o resultado na UI
            showToast('Ajuste de jornada salvo!', 'success');
            // Limpa o formulário
            setFormData({
                nomeOperador: '',
                motorista: '',
                ajusteJornadaTipo: '',
                dataHoraOcorrencia: '',
                placaVeiculo: '',
                motivoAjuste: '',
            });
        } catch (error) {
            console.error('Erro ao salvar ajuste de jornada:', error);
            setFormError('Erro ao salvar registro de ajuste de jornada. Tente novamente.');
            showToast('Erro ao salvar ajuste de jornada.', 'error');
        } finally {
            setLoading(false);
        }
    };

    const ajusteJornadaTipos = [
        "INICIO DE JORNADA NÃO COMPUTADO", "FIM DE JORNADA NÃO INFORMADO",
        "INICIOU SEM INDICIO DE MOVIMENTAÇÃO(06:00)", "EXCESSO DE HORAS PARADO PRÉ FIM DE JORNADA",
        "MARCAÇÃO NÃO COMPUTADA ENTRE JORNADAS", "UNIFICAÇÃO DE JORNADAS",
        "LANÇAMENTO DE DIÁRIO DE BORDO MANUAL", "ERRO EM MARCAÇÃO REALIZADA",
        "JORNADA NÃO FINALIZADA", "JORNADA NÃO INICIADA"
    ];

    return (
        <div className="p-8 bg-white rounded-xl shadow-lg flex flex-col items-center">
            <Header title="⏰ Ajuste de Jornada" subtitle="Gerencie e ajuste as jornadas de trabalho dos motoristas." />

            <div className="w-full max-w-3xl bg-gray-50 p-6 rounded-lg shadow-inner">
                <form onSubmit={handleSubmit} className="space-y-6">
                    <FormField
                        id="nomeOperador"
                        label="👤 Nome do Operador"
                        type="select"
                        value={formData.nomeOperador}
                        onChange={handleInputChange}
                        required
                    >
                        <option value="">-- Selecione o operador --</option>
                        {appData.operadores.map(op => (
                            <option key={op.nome} value={op.nome}>
                                {op.nome}
                            </option>
                        ))}
                    </FormField>

                    <FormField
                        id="motorista"
                        label="👨‍✈️ Motorista:"
                        type="select"
                        value={formData.motorista}
                        onChange={handleInputChange}
                        required
                    >
                        <option value="">-- Selecione um motorista --</option>
                        {appData.motoristas.map(m => (
                            <option key={m.cpf} value={m.nome}>
                                {m.nome}
                            </option>
                        ))}
                    </FormField>

                    <FormField
                        id="ajusteJornadaTipo"
                        label="📝 Tipo de Ajuste de Jornada"
                        type="select"
                        value={formData.ajusteJornadaTipo}
                        onChange={handleInputChange}
                        required
                    >
                        <option value="">-- Selecione o tipo de ajuste --</option>
                        {ajusteJornadaTipos.map(tipo => (
                            <option key={tipo} value={tipo}>
                                {tipo}
                            </option>
                        ))}
                    </FormField>

                    <FormField
                        id="dataHoraOcorrencia"
                        label="🗓️ Data e Hora da Ocorrência"
                        type="datetime-local"
                        value={formData.dataHoraOcorrencia}
                        onChange={handleInputChange}
                        required
                    />

                    <FormField
                        id="placaVeiculo"
                        label="🚚 Placa do Veículo"
                        type="select"
                        value={formData.placaVeiculo}
                        onChange={handleInputChange}
                        required
                    >
                        <option value="">-- Selecione um veículo --</option>
                        {appData.veiculos.map(v => (
                            <option key={v.placa} value={v.placa}>
                                {v.placa} - {v.modelo}
                            </option>
                        ))}
                    </FormField>

                    <FormField
                        id="motivoAjuste"
                        label="💬 Motivo do Ajuste"
                        type="textarea"
                        placeholder="Descreva o motivo do ajuste de jornada"
                        value={formData.motivoAjuste}
                        onChange={handleInputChange}
                        required
                    />

                    {formError && (
                        <div className="bg-red-100 text-red-700 p-3 rounded-lg border border-red-200 text-sm">
                            {formError}
                        </div>
                    )}

                    <button
                        type="submit"
                        className="w-full bg-indigo-600 text-white font-bold py-3 px-6 rounded-lg shadow-md hover:bg-indigo-700 transition-colors duration-200 flex items-center justify-center gap-2"
                        disabled={loading}
                    >
                        {loading && <LoadingSpinner />}
                        {loading ? 'Salvando Ajuste...' : '💾 Salvar Ajuste de Jornada'}
                    </button>
                </form>

                {result && (
                    <div className="mt-8 p-6 bg-white rounded-lg shadow-md border-t-4 border-green-500 animate-fade-in">
                        <h2 className="text-2xl font-bold text-gray-800 mb-4 text-center">✅ Ajuste de Jornada Salvo com Sucesso!</h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-gray-700">
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Operador:</p>
                                <p>{result.nomeOperador}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Motorista:</p>
                                <p>{result.motorista}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md col-span-full">
                                <p className="font-semibold">Tipo de Ajuste:</p>
                                <p>{result.ajusteJornadaTipo}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Ocorrência:</p>
                                <p>{new Date(result.dataHoraOcorrencia).toLocaleString('pt-BR')}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Veículo:</p>
                                <p>{result.placaVeiculo}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md col-span-full">
                                <p className="font-semibold">Motivo:</p>
                                <p>{result.motivoAjuste}</p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

/**
 * Componente para o formulário de Ocorrências.
 */
const OcorrenciasForm = () => {
    const { appData } = useContext(AppContext);
    const { addDocument } = useFirestoreOperations();
    const { showToast } = useContext(AppContext);

    const [formData, setFormData] = useState({
        nomeOperador: '',
        dataHoraOcorrencia: '',
        tipoOcorrencia: '',
        descricao: '',
        motoristaEnvolvido: '',
        placaVeiculoEnvolvido: '',
        status: '',
    });
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [formError, setFormError] = useState('');

    const handleInputChange = (e) => {
        const { id, value } = e.target;
        setFormData(prev => ({ ...prev, [id]: value }));
        setFormError('');
        setResult(null);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setFormError('');
        setResult(null);

        const formElement = e.target;
        let isValid = validateForm(formElement);

        if (!isValid) {
            setLoading(false);
            showToast('Preencha todos os campos obrigatórios corretamente.', 'error');
            return;
        }

        try {
            await addDocument('ocorrencias', {
                nomeOperador: formData.nomeOperador,
                dataHoraOcorrencia: new Date(formData.dataHoraOcorrencia),
                tipoOcorrencia: formData.tipoOcorrencia,
                descricao: formData.descricao,
                motoristaEnvolvido: formData.motoristaEnvolvido,
                placaVeiculoEnvolvido: formData.placaVeiculoEnvolvido,
                status: formData.status,
            });

            setResult(formData);
            showToast('Ocorrência registrada!', 'success');
            // Limpa o formulário
            setFormData({
                nomeOperador: '',
                dataHoraOcorrencia: '',
                tipoOcorrencia: '',
                descricao: '',
                motoristaEnvolvido: '',
                placaVeiculoEnvolvido: '',
                status: '',
            });
        } catch (error) {
            console.error('Erro ao salvar ocorrência:', error);
            setFormError('Erro ao salvar registro de ocorrência. Tente novamente.');
            showToast('Erro ao salvar ocorrência.', 'error');
        } finally {
            setLoading(false);
        }
    };

    const tiposOcorrencia = [
        "ACIDENTE", "MULTA", "PROBLEMA MECÂNICO", "ATRASO",
        "ROUBO/FURTO", "QUEBRA DE CARGA", "VIOLAÇÃO DE NORMAS", "OUTROS"
    ];
    const statusOcorrencia = ["ABERTA", "EM ANÁLISE", "RESOLVIDA", "CANCELADA"];

    return (
        <div className="p-8 bg-white rounded-xl shadow-lg flex flex-col items-center">
            <Header title="🚨 Controle de Ocorrências" subtitle="Registre e gerencie ocorrências relacionadas aos motoristas e veículos." />

            <div className="w-full max-w-3xl bg-gray-50 p-6 rounded-lg shadow-inner">
                <form onSubmit={handleSubmit} className="space-y-6">
                    <FormField
                        id="nomeOperador"
                        label="👤 Nome do Operador"
                        type="select"
                        value={formData.nomeOperador}
                        onChange={handleInputChange}
                        required
                    >
                        <option value="">-- Selecione o operador --</option>
                        {appData.operadores.map(op => (
                            <option key={op.nome} value={op.nome}>
                                {op.nome}
                            </option>
                        ))}
                    </FormField>

                    <FormField
                        id="dataHoraOcorrencia"
                        label="🗓️ Data e Hora da Ocorrência"
                        type="datetime-local"
                        value={formData.dataHoraOcorrencia}
                        onChange={handleInputChange}
                        required
                    />

                    <FormField
                        id="tipoOcorrencia"
                        label="📝 Tipo de Ocorrência"
                        type="select"
                        value={formData.tipoOcorrencia}
                        onChange={handleInputChange}
                        required
                    >
                        <option value="">-- Selecione o tipo de ocorrência --</option>
                        {tiposOcorrencia.map(tipo => (
                            <option key={tipo} value={tipo}>
                                {tipo}
                            </option>
                        ))}
                    </FormField>

                    <FormField
                        id="descricao"
                        label="💬 Descrição da Ocorrência"
                        type="textarea"
                        placeholder="Detalhes da ocorrência"
                        value={formData.descricao}
                        onChange={handleInputChange}
                        required
                    />

                    <FormField
                        id="motoristaEnvolvido"
                        label="👨‍✈️ Motorista Envolvido:"
                        type="select"
                        value={formData.motoristaEnvolvido}
                        onChange={handleInputChange}
                        required
                    >
                        <option value="">-- Selecione um motorista --</option>
                        {appData.motoristas.map(m => (
                            <option key={m.cpf} value={m.nome}>
                                {m.nome}
                            </option>
                        ))}
                    </FormField>

                    <FormField
                        id="placaVeiculoEnvolvido"
                        label="🚚 Veículo Envolvido:"
                        type="select"
                        value={formData.placaVeiculoEnvolvido}
                        onChange={handleInputChange}
                        required
                    >
                        <option value="">-- Selecione um veículo --</option>
                        {appData.veiculos.map(v => (
                            <option key={v.placa} value={v.placa}>
                                {v.placa} - {v.modelo}
                            </option>
                        ))}
                    </FormField>

                    <FormField
                        id="status"
                        label="🚦 Status da Ocorrência"
                        type="select"
                        value={formData.status}
                        onChange={handleInputChange}
                        required
                    >
                        <option value="">-- Selecione o status --</option>
                        {statusOcorrencia.map(status => (
                            <option key={status} value={status}>
                                {status}
                            </option>
                        ))}
                    </FormField>

                    {formError && (
                        <div className="bg-red-100 text-red-700 p-3 rounded-lg border border-red-200 text-sm">
                            {formError}
                        </div>
                    )}

                    <button
                        type="submit"
                        className="w-full bg-indigo-600 text-white font-bold py-3 px-6 rounded-lg shadow-md hover:bg-indigo-700 transition-colors duration-200 flex items-center justify-center gap-2"
                        disabled={loading}
                    >
                        {loading && <LoadingSpinner />}
                        {loading ? 'Registrando Ocorrência...' : '🚨 Registrar Ocorrência'}
                    </button>
                </form>

                {result && (
                    <div className="mt-8 p-6 bg-white rounded-lg shadow-md border-t-4 border-green-500 animate-fade-in">
                        <h2 className="text-2xl font-bold text-gray-800 mb-4 text-center">✅ Ocorrência Registrada com Sucesso!</h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-gray-700">
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Operador:</p>
                                <p>{result.nomeOperador}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Tipo:</p>
                                <p>{result.tipoOcorrencia}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Ocorrência em:</p>
                                <p>{new Date(result.dataHoraOcorrencia).toLocaleString('pt-BR')}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Motorista:</p>
                                <p>{result.motoristaEnvolvido}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Veículo:</p>
                                <p>{result.placaVeiculoEnvolvido}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md">
                                <p className="font-semibold">Status:</p>
                                <p>{result.status}</p>
                            </div>
                            <div className="p-3 bg-gray-50 rounded-md col-span-full">
                                <p className="font-semibold">Descrição:</p>
                                <p>{result.descricao}</p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

// =================================================================================
// COMPONENTES DE HISTÓRICO
// =================================================================================

/**
 * Componente para renderizar uma linha de abastecimento na tabela.
 */
const AbastecimentoRow = ({ record, onEdit, onDelete }) => (
    <tr className="hover:bg-gray-50 transition-colors duration-150">
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.dataRegistro?.toDate().toLocaleString('pt-BR') || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.tipoVeiculo || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.origemDestino || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.placaVeiculo || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.motorista || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700 text-right">{`${(record.litrosCalculados || 0).toFixed(1)}L`}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.necessitaAbastecer ? 'Sim' : 'Não'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">
            <div className="flex justify-center space-x-2">
                <button onClick={() => onEdit(record.id, record)} className="text-blue-500 hover:text-blue-700 p-1 rounded-full hover:bg-blue-100 transition-colors" title="Editar">✏️</button>
                <button onClick={() => onDelete(record.id, record)} className="text-red-500 hover:text-red-700 p-1 rounded-full hover:bg-red-100 transition-colors" title="Excluir">🗑️</button>
            </div>
        </td>
    </tr>
);

/**
 * Componente para renderizar uma linha de premiação na tabela.
 */
const PremiacaoRow = ({ record, onEdit, onDelete }) => (
    <tr className="hover:bg-gray-50 transition-colors duration-150">
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.dataRegistro?.toDate().toLocaleString('pt-BR') || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.motorista || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.tipoOperacao || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.origemCarga || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.finalCarga || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700 text-right">{record.kmReferenciaDaRota ? `${record.kmReferenciaDaRota} KM` : 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.situacaoMedia || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700 text-right">{record.valorTotalPremio ? `R$ ${record.valorTotalPremio.toFixed(2).replace('.', ',')}` : 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">
            <div className="flex justify-center space-x-2">
                <button onClick={() => onEdit(record.id, record)} className="text-blue-500 hover:text-blue-700 p-1 rounded-full hover:bg-blue-100 transition-colors" title="Editar">✏️</button>
                <button onClick={() => onDelete(record.id, record)} className="text-red-500 hover:text-red-700 p-1 rounded-full hover:bg-red-100 transition-colors" title="Excluir">🗑️</button>
            </div>
        </td>
    </tr>
);

/**
 * Componente para renderizar uma linha de ajuste de jornada na tabela.
 */
const AjusteJornadaRow = ({ record, onEdit, onDelete }) => (
    <tr className="hover:bg-gray-50 transition-colors duration-150">
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.dataRegistro?.toDate().toLocaleString('pt-BR') || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.nomeOperador || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.motorista || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.ajusteJornadaTipo || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.dataHoraOcorrencia ? record.dataHoraOcorrencia.toDate().toLocaleString('pt-BR') : 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.placaVeiculo || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.motivoAjuste || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">
            <div className="flex justify-center space-x-2">
                <button onClick={() => onEdit(record.id, record)} className="text-blue-500 hover:text-blue-700 p-1 rounded-full hover:bg-blue-100 transition-colors" title="Editar">✏️</button>
                <button onClick={() => onDelete(record.id, record)} className="text-red-500 hover:text-red-700 p-1 rounded-full hover:bg-red-100 transition-colors" title="Excluir">🗑️</button>
            </div>
        </td>
    </tr>
);

/**
 * Componente para renderizar uma linha de ocorrência na tabela.
 */
const OcorrenciaRow = ({ record, onEdit, onDelete }) => (
    <tr className="hover:bg-gray-50 transition-colors duration-150">
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.dataRegistro?.toDate().toLocaleString('pt-BR') || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.dataHoraOcorrencia ? record.dataHoraOcorrencia.toDate().toLocaleString('pt-BR') : 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.tipoOcorrencia || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.descricao || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.nomeOperador || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.motoristaEnvolvido || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.placaVeiculoEnvolvido || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">{record.status || 'N/A'}</td>
        <td className="py-3 px-4 border-b border-gray-200 text-sm text-gray-700">
            <div className="flex justify-center space-x-2">
                <button onClick={() => onEdit(record.id, record)} className="text-blue-500 hover:text-blue-700 p-1 rounded-full hover:bg-blue-100 transition-colors" title="Editar">✏️</button>
                <button onClick={() => onDelete(record.id, record)} className="text-red-500 hover:text-red-700 p-1 rounded-full hover:bg-red-100 transition-colors" title="Excluir">🗑️</button>
            </div>
        </td>
    </tr>
);

/**
 * Componente de Tabela de Histórico Genérica.
 */
const HistoryTable = ({ title, records, columns, RowComponent, collectionName }) => {
    const { deleteDocument } = useFirestoreOperations();
    const { showModal, showToast } = useContext(AppContext);

    const handleEdit = useCallback((id, data) => {
        showModal('Funcionalidade em Desenvolvimento', `A edição de registros está em desenvolvimento. ID: ${id} da coleção: ${collectionName}.`, 'info');
        // Implementar lógica de edição aqui: preencher formulário, etc.
    }, [showModal, collectionName]);

    const handleDelete = useCallback(async (id, data) => {
        const confirmed = await showModal(
            'Confirmar Exclusão',
            `Tem certeza que deseja excluir este registro? Esta ação é irreversível.`,
            'confirm'
        );

        if (confirmed) {
            try {
                await deleteDocument(collectionName, id);
                showToast('Registro excluído com sucesso!', 'success');
            } catch (error) {
                console.error(`Erro ao excluir registro ${id} da coleção ${collectionName}:`, error);
                showToast('Erro ao excluir registro. Tente novamente.', 'error');
            }
        } else {
            showToast('Exclusão cancelada.', 'info');
        }
    }, [deleteDocument, collectionName, showModal, showToast]);

    return (
        <div className="bg-white rounded-xl shadow-lg p-6 mt-8">
            <h2 className="text-2xl font-bold text-gray-800 mb-6 text-center">{title}</h2>
            <div className="overflow-x-auto rounded-lg border border-gray-200 shadow-sm">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-100">
                        <tr>
                            {columns.map((col, index) => (
                                <th key={index} className="py-3 px-4 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                                    {col}
                                </th>
                            ))}
                            <th className="py-3 px-4 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider">Ações</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-100">
                        {records.length === 0 ? (
                            <tr>
                                <td colSpan={columns.length + 1} className="py-6 text-center text-gray-500 italic">
                                    Nenhum registro encontrado.
                                </td>
                            </tr>
                        ) : (
                            records.map(record => (
                                <RowComponent key={record.id} record={record} onEdit={handleEdit} onDelete={handleDelete} />
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

/**
 * Componente para a seção de Histórico de Registros.
 */
const HistoricoSection = () => {
    const { showToast, showModal } = useContext(AppContext);
    const [activeTab, setActiveTab] = useState('abastecimentos');
    const [searchTerm, setSearchTerm] = useState('');

    // Hooks para buscar os registros do usuário
    const { records: abastecimentos, loading: loadingAbastecimentos, error: errorAbastecimentos } = useUserRecords('abastecimentos');
    const { records: premiacoes, loading: loadingPremiacoes, error: errorPremiacoes } = useUserRecords('premiacoes');
    const { records: ajustesJornada, loading: loadingAjustesJornada, error: errorAjustesJornada } = useUserRecords('ajustesJornada');
    const { records: ocorrencias, loading: loadingOcorrencias, error: errorOcorrencias } = useUserRecords('ocorrencias');

    const filterRecords = (records) => {
        if (!searchTerm) return records;
        const lowerCaseSearchTerm = searchTerm.toLowerCase();
        return records.filter(record =>
            Object.values(record).some(value =>
                String(value).toLowerCase().includes(lowerCaseSearchTerm)
            )
        );
    };

    const getTableData = useCallback(() => {
        switch (activeTab) {
            case 'abastecimentos':
                return {
                    records: filterRecords(abastecimentos),
                    loading: loadingAbastecimentos,
                    error: errorAbastecimentos,
                    columns: ['Data', 'Tipo', 'Rota', 'Veículo', 'Motorista', 'Litros Calculados', 'Necessário Abastecer'],
                    RowComponent: AbastecimentoRow,
                    collectionName: 'abastecimentos'
                };
            case 'premiacoes':
                return {
                    records: filterRecords(premiacoes),
                    loading: loadingPremiacoes,
                    error: errorPremiacoes,
                    columns: ['Data', 'Motorista', 'Operação', 'Origem', 'Destino', 'KM Ref.', 'Média Atingida', 'Premiação'],
                    RowComponent: PremiacaoRow,
                    collectionName: 'premiacoes'
                };
            case 'ajustesJornada':
                return {
                    records: filterRecords(ajustesJornada),
                    loading: loadingAjustesJornada,
                    error: errorAjustesJornada,
                    columns: ['Data Registro', 'Operador', 'Motorista', 'Tipo de Ajuste', 'Data da Ocorrência', 'Veículo', 'Motivo'],
                    RowComponent: AjusteJornadaRow,
                    collectionName: 'ajustesJornada'
                };
            case 'ocorrencias':
                return {
                    records: filterRecords(ocorrencias),
                    loading: loadingOcorrencias,
                    error: errorOcorrencias,
                    columns: ['Data Registro', 'Data Ocorrência', 'Tipo', 'Descrição', 'Operador', 'Motorista', 'Veículo', 'Status'],
                    RowComponent: OcorrenciaRow,
                    collectionName: 'ocorrencias'
                };
            default:
                return { records: [], loading: false, error: null, columns: [], RowComponent: () => null, collectionName: '' };
        }
    }, [activeTab, searchTerm, abastecimentos, premiacoes, ajustesJornada, ocorrencias, loadingAbastecimentos, loadingPremiacoes, loadingAjustesJornada, loadingOcorrencias, errorAbastecimentos, errorPremiacoes, errorAjustesJornada, errorOcorrencias]);

    const { records, loading, error, columns, RowComponent, collectionName } = getTableData();

    useEffect(() => {
        if (error) {
            showToast(`Erro ao carregar histórico: ${error.message}`, 'error');
        }
    }, [error, showToast]);

    return (
        <section className="p-8 bg-white rounded-xl shadow-lg flex flex-col items-center">
            <Header title="📚 Histórico de Registros" subtitle="Consulte todos os abastecimentos, premiações, ajustes de jornada e ocorrências registrados." />

            <div className="w-full max-w-5xl bg-gray-50 p-6 rounded-lg shadow-inner">
                <div className="mb-6">
                    <input
                        type="text"
                        placeholder="🔍 Pesquisar no histórico..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full p-3 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300 transition-all duration-200"
                    />
                </div>

                <div className="flex flex-wrap justify-center gap-4 mb-8 bg-gray-100 p-2 rounded-lg shadow-sm">
                    <button
                        onClick={() => setActiveTab('abastecimentos')}
                        className={`px-6 py-3 rounded-lg font-semibold transition-all duration-200 ${activeTab === 'abastecimentos' ? 'bg-indigo-600 text-white shadow-md' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
                    >
                        Abastecimentos
                    </button>
                    <button
                        onClick={() => setActiveTab('premiacoes')}
                        className={`px-6 py-3 rounded-lg font-semibold transition-all duration-200 ${activeTab === 'premiacoes' ? 'bg-indigo-600 text-white shadow-md' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
                    >
                        Premiações
                    </button>
                    <button
                        onClick={() => setActiveTab('ajustesJornada')}
                        className={`px-6 py-3 rounded-lg font-semibold transition-all duration-200 ${activeTab === 'ajustesJornada' ? 'bg-indigo-600 text-white shadow-md' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
                    >
                        Ajustes de Jornada
                    </button>
                    <button
                        onClick={() => setActiveTab('ocorrencias')}
                        className={`px-6 py-3 rounded-lg font-semibold transition-all duration-200 ${activeTab === 'ocorrencias' ? 'bg-indigo-600 text-white shadow-md' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
                    >
                        Ocorrências
                    </button>
                </div>

                {loading ? (
                    <div className="flex justify-center items-center h-48">
                        <LoadingSpinner size="w-12 h-12" color="text-indigo-500" />
                        <p className="ml-4 text-gray-600 text-lg">Carregando histórico...</p>
                    </div>
                ) : (
                    <HistoryTable
                        title={`Registros de ${activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}`}
                        records={records}
                        columns={columns}
                        RowComponent={RowComponent}
                        collectionName={collectionName}
                    />
                )}
            </div>
        </section>
    );
};

// =================================================================================
// COMPONENTE PRINCIPAL DA APLICAÇÃO (APP)
// =================================================================================

const App = () => {
    const { db, auth, userId, appId, isAuthReady } = useFirebase();
    const { showModal, modalState, closeModal } = useModal();
    const [activeSection, setActiveSection] = useState('welcome'); // Seção inicial
    const [appData, setAppData] = useState({
        veiculos: [],
        motoristas: [],
        premiosFixosPorRota: [],
        operadores: []
    });

    // Use useFirebaseData para buscar os dados públicos
    const { data: fetchedVeiculos, loading: loadingVeiculos, error: errorVeiculos } = useFirebaseData('veiculos');
    const { data: fetchedMotoristas, loading: loadingMotoristas, error: errorMotoristas } = useFirebaseData('motoristas');
    const { data: fetchedPremiosFixosPorRota, loading: loadingPremiosFixosPorRota, error: errorPremiosFixosPorRota } = useFirebaseData('premiosFixosPorRota');
    const { data: fetchedOperadores, loading: loadingOperadores, error: errorOperadores } = useFirebaseData('operadores');

    const [dataLoading, setDataLoading] = useState(true);
    const [dataError, setDataError] = useState(null);

    // Função para recarregar todos os dados públicos
    const refreshAppData = useCallback(() => {
        // Re-executa os hooks de useFirebaseData forçando uma nova busca
        // Isso é feito indiretamente ao re-renderizar o AppContext Provider com novos dados
        // ou você pode adicionar um estado de 'refreshKey' nos hooks de dados.
        // Por simplicidade, vamos apenas confiar que os hooks de useFirebaseData já estão reagindo às mudanças no DB.
        // No entanto, para um refresh explícito, você pode usar um estado de timestamp.
        // Por enquanto, a simples redefinição de loading é uma indicação visual.
        setDataLoading(true); // Força o estado de loading para indicar que os dados estão sendo atualizados
    }, []);


    useEffect(() => {
        if (isAuthReady) {
            // Verifica se todos os dados públicos foram carregados (ou se houve erro)
            const allLoaded = !loadingVeiculos && !loadingMotoristas && !loadingPremiosFixosPorRota && !loadingOperadores;
            const anyError = errorVeiculos || errorMotoristas || errorPremiosFixosPorRota || errorOperadores;

            if (allLoaded) {
                if (anyError) {
                    setDataError(new Error("Erro ao carregar alguns dados iniciais. Verifique o console."));
                    window.showToast('Erro ao carregar dados iniciais.', 'error');
                } else {
                    // Ordenar os dados antes de armazenar no estado global
                    const sortedVeiculos = [...fetchedVeiculos].sort((a, b) => a.placa.localeCompare(b.placa));
                    const sortedMotoristas = [...fetchedMotoristas].sort((a, b) => a.nome.localeCompare(b.nome));
                    const sortedOperadores = [...fetchedOperadores].sort((a, b) => a.nome.localeCompare(b.nome));
                    // Normalizar prêmios por rota para busca
                    const normalizedPremios = fetchedPremiosFixosPorRota.map(p => ({
                        ...p,
                        origem: normalizeCityName(p.origemDisplay),
                        destino: normalizeCityName(p.destinoDisplay),
                    }));
                    const sortedPremios = [...normalizedPremios].sort((a, b) => a.origemDisplay.localeCompare(b.origemDisplay));


                    setAppData({
                        veiculos: sortedVeiculos.length > 0 ? sortedVeiculos : [],
                        motoristas: sortedMotoristas.length > 0 ? sortedMotoristas : [],
                        premiosFixosPorRota: sortedPremios.length > 0 ? sortedPremios : [],
                        operadores: sortedOperadores.length > 0 ? sortedOperadores : [],
                    });

                    if (sortedVeiculos.length === 0 || sortedMotoristas.length === 0 || sortedPremios.length === 0 || sortedOperadores.length === 0) {
                        window.showToast('Alguns dados essenciais estão faltando. Considere usar a seção "Gerenciar Dados" para fazer upload.', 'warning');
                    } else {
                        window.showToast('Dados iniciais carregados com sucesso!', 'success');
                    }
                }
                setDataLoading(false);
            }
        }
    }, [isAuthReady, fetchedVeiculos, fetchedMotoristas, fetchedPremiosFixosPorRota, fetchedOperadores, loadingVeiculos, loadingMotoristas, loadingPremiosFixosPorRota, loadingOperadores, errorVeiculos, errorMotoristas, errorPremiosFixosPorRota, errorOperadores]);


    const handleNavigate = (sectionId) => {
        setActiveSection(sectionId);
    };

    if (!isAuthReady || dataLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-600 to-purple-700 text-white">
                <div className="flex flex-col items-center p-8 bg-white bg-opacity-20 rounded-xl shadow-lg">
                    <LoadingSpinner size="w-16 h-16" color="text-white" />
                    <p className="mt-4 text-xl font-semibold">Carregando aplicação...</p>
                    {dataError && <p className="mt-2 text-red-300 text-sm">{dataError.message}</p>}
                </div>
            </div>
        );
    }

    return (
        <FirebaseContext.Provider value={{ db, auth, userId, appId, isAuthReady }}>
            <AppContext.Provider value={{ appData, showToast, showModal, refreshData: refreshAppData }}>
                <div className="min-h-screen bg-gray-100 flex font-inter antialiased">
                    <ToastContainer />
                    {modalState && (
                        <Modal
                            title={modalState.title}
                            message={modalState.message}
                            type={modalState.type}
                            onClose={modalState.resolve}
                            onConfirm={() => modalState.resolve(true)}
                            onCancel={() => modalState.resolve(false)}
                        />
                    )}

                    {activeSection !== 'welcome' && (
                        <Sidebar activeSection={activeSection} onNavigate={handleNavigate} userId={userId} />
                    )}

                    <main className="flex-1 p-6 md:p-8 lg:p-10 flex justify-center items-start overflow-auto">
                        <div className="w-full max-w-7xl">
                            {activeSection === 'welcome' && <WelcomeSection onNavigate={handleNavigate} />}
                            {activeSection === 'abastecimento' && <AbastecimentoForm />}
                            {activeSection === 'premiacao' && <PremiacaoForm />}
                            {activeSection === 'ajusteJornada' && <AjusteJornadaForm />}
                            {activeSection === 'ocorrencias' && <OcorrenciasForm />}
                            {activeSection === 'historico' && <HistoricoSection />}
                            {activeSection === 'dataManagement' && <DataManagementSection />}
                        </div>
                    </main>
                </div>
            </AppContext.Provider>
        </FirebaseContext.Provider>
    );
};

export default App;
