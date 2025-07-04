// calculationLogic.js
// Este arquivo permanece em JavaScript puro, pois contém apenas lógica de negócio.

/**
 * calculationLogic.js
 * Contém a lógica de negócios para os cálculos de combustível e premiação.
 */

import { CONFIG } from './constants'; // Importa CONFIG de constants.js
import { normalizeCityName } from './dataUtils'; // Importa normalizeCityName de dataUtils.js

/**
 * Calcula o consumo de combustível e a necessidade de abastecimento para uma rota.
 * @param {object} dados - Dados de entrada do formulário de abastecimento.
 * @param {object} veiculoSelecionado - Objeto completo do veículo selecionado, contendo tipo, tanque, etc.
 * @returns {object} Um objeto com os resultados do cálculo.
 */
export function calculateAbastecimento(dados, veiculoSelecionado) {
    const { tipo, kmCarregado, kmVazio, combRestante } = dados;
    const { tanque } = veiculoSelecionado;

    // Se o veículo for de almoxarifado, não há cálculo de combustível
    if (tipo === 'almoxarifado bwa') {
        return {
            tipoCalculado: 'almoxarifado bwa',
            precisaAbastecer: false,
            litrosTotais: 0,
            litrosExtras: 0,
            tanqueUtilizavel: 0,
            litrosDisponiveis: 0,
            veiculo: veiculoSelecionado,
            pesos: CONFIG.PESOS[tipo],
            medias: CONFIG.CONSUMO_MEDIO[tipo]
        };
    }

    const pesos = CONFIG.PESOS[tipo];
    const medias = CONFIG.CONSUMO_MEDIO[tipo];

    if (!pesos || !medias) {
        throw new Error(`Dados de configuração (pesos ou médias) não encontrados para o tipo de veículo: ${tipo}`);
    }

    // Calcula os litros necessários para KM carregado e vazio
    const litrosCarregado = kmCarregado / medias.carregado;
    const litrosVazio = kmVazio / medias.vazio;
    const litrosTotais = litrosCarregado + litrosVazio;

    // Calcula a capacidade utilizável do tanque (total - reserva)
    const tanqueUtilizavel = tanque - CONFIG.RESERVA_TANQUE;
    const litrosDisponiveis = (tanqueUtilizavel * (combRestante / 100)); // Usar tanqueUtilizavel aqui

    // Determina se precisa abastecer
    const precisaAbastecer = litrosTotais > litrosDisponiveis;
    const litrosExtras = precisaAbastecer ? litrosTotais - litrosDisponiveis : 0;

    return {
        tipoCalculado: tipo,
        litrosTotais,
        tanqueUtilizavel,
        litrosDisponiveis,
        precisaAbastecer,
        litrosExtras,
        veiculo: veiculoSelecionado, // Retorna o objeto completo do veículo
        pesos,
        medias
    };
}

/**
 * Calcula o valor da premiação de um motorista com base na rota e desempenho.
 * @param {object} dados - Dados de entrada do formulário de premiação.
 * @param {Array<object>} premiosFixosPorRota - Array de objetos com os valores de premiação por rota.
 * @returns {object} Um objeto com os resultados do cálculo da premiação.
 */
export function calculatePremiacao(dados, premiosFixosPorRota) {
    const { motorista, tipoOperacao, origemCarga, finalCarga, quilometragem, atingiuMedia } = dados;

    // Normaliza os nomes das cidades para a busca, caso não estejam já normalizados
    const origemNormalized = normalizeCityName(origemCarga);
    const destinoNormalized = normalizeCityName(finalCarga);

    const rotaEncontrada = premiosFixosPorRota.find(p =>
        p.tipoOperacao === tipoOperacao &&
        normalizeCityName(p.origemDisplay) === origemNormalized &&
        normalizeCityName(p.destinoDisplay) === destinoNormalized
    );

    if (!rotaEncontrada) {
        // Isso não deve acontecer se a UI estiver correta, mas é um fallback de segurança
        throw new Error(`Rota de premiação não encontrada para: ${origemCarga} para ${finalCarga} (${tipoOperacao}).`);
    }

    let valorTotalPremio = 0;
    let situacaoMedia = 'Não Aplicável'; // Default para caso não se encaixe

    if (atingiuMedia === true) {
        valorTotalPremio = rotaEncontrada.valorAcimaMedia;
        situacaoMedia = 'Acima da Média';
    } else if (atingiuMedia === false) {
        valorTotalPremio = rotaEncontrada.valorAbaixoMedia;
        situacaoMedia = 'Abaixo da Média';
    }

    return {
        motorista,
        tipoOperacao,
        origemDisplay: rotaEncontrada.origemDisplay, // Retorna o nome original para exibição
        destinoDisplay: rotaEncontrada.destinoDisplay, // Retorna o nome original para exibição
        quilometragemInformada: quilometragem,
        kmReferenciaDaRota: rotaEncontrada.kmReferencia,
        atingiuMedia: atingiuMedia,
        situacaoMedia,
        valorTotalPremio
    };
}
