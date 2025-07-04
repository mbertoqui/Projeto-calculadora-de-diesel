// dataUtils.js
// Contém funções utilitárias para manipulação e formatação de dados.

/**
 * dataUtils.js
 * Contém funções utilitárias para manipulação e formatação de dados.
 */

/**
 * Normaliza nomes de cidades, removendo acentos e convertendo para minúsculas.
 * Usado para padronizar a comparação de rotas.
 * @param {string} cityName - O nome da cidade.
 * @returns {string} O nome da cidade normalizado.
 */
export function normalizeCityName(cityName) {
    if (!cityName) return '';
    return cityName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Formata um CPF para exibição.
 * @param {string} cpf - O CPF (somente números).
 * @returns {string} O CPF formatado (ex: "123.456.789-00").
 */
export function formatarCPF(cpf) {
    if (!cpf) return 'N/A';
    // Remove qualquer coisa que não seja dígito
    const cleanCpf = String(cpf).replace(/\D/g, ''); // Garante que cpf é string
    // Aplica a máscara
    if (cleanCpf.length === 11) {
        return cleanCpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    }
    return cpf; // Retorna o original se não tiver 11 dígitos
}

/**
 * Converte uma string de moeda "R$ X,XX" para um número float.
 * Trata pontos de milhar e vírgula decimal.
 * @param {string} currencyString - A string de moeda a ser convertida.
 * @returns {number} O valor numérico da moeda ou NaN se a string for inválida.
 */
export function parseCurrencyToNumber(currencyString) {
    if (!currencyString || typeof currencyString !== 'string' || currencyString.trim() === '') {
        return NaN; // Retorna NaN para valores vazios ou inválidos
    }
    // Remove "R$", pontos de milhar e substitui vírgula decimal por ponto
    const cleanedString = currencyString.replace('R$', '').replace(/\./g, '').replace(',', '.').trim();
    return parseFloat(cleanedString);
}
