// constants.js
// Contém constantes globais da aplicação.

export const CONFIG = {
    RESERVA_TANQUE: 100, // Litros de reserva
    PESOS: {
      carreta: { carregado: 53, vazio: 18 },
      truck: { carregado: 23, vazio: 8 },
      "almoxarifado bwa": { carregado: 0, vazio: 0 } // Peso para veículos de almoxarifado (não aplicável)
    },
    CONSUMO_MEDIO: {
      carreta: { carregado: 2.5, vazio: 3.5 }, // km/litro
      truck: { carregado: 4.0, vazio: 6.0 },   // km/litro
      "almoxarifado bwa": { carregado: Infinity, vazio: Infinity } // Não consome combustível
    }
};
