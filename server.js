const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 3000;

// Configurações do Puppeteer
let browser;
let isBrowserReady = false;

// Inicializar browser Puppeteer
async function initBrowser() {
    try {
        console.log('🚀 Iniciando browser Puppeteer...');
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ]
        });
        isBrowserReady = true;
        console.log('✅ Browser Puppeteer iniciado com sucesso!');
    } catch (error) {
        console.error('❌ Erro ao iniciar browser:', error);
        isBrowserReady = false;
    }
}

// Função para extrair data do texto - SUPER ROBUSTA
function extractDateFromText(texto) {
    if (!texto || typeof texto !== 'string') return null;

    const rawText = texto
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

    const publicadoMatch = rawText.match(/publicado em\s+(.{0,60})/i);
    if (publicadoMatch) {
        const parsed = extractDateFromText(publicadoMatch[1]);
        if (parsed) return parsed;
    }

    const datePatterns = [
        /(\d{2})\/(\d{2})\/(\d{4})/,
        /(\d{4})-(\d{2})-(\d{2})/,
        /(\d{1,2})\s+de\s+(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(\d{4})/,
        /(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(\d{4})/
    ];

    const monthMap = {
        janeiro: '01',
        fevereiro: '02',
        marco: '03',
        abril: '04',
        maio: '05',
        junho: '06',
        julho: '07',
        agosto: '08',
        setembro: '09',
        outubro: '10',
        novembro: '11',
        dezembro: '12'
    };

    for (const pattern of datePatterns) {
        const match = rawText.match(pattern);
        if (!match) continue;

        let day = '01';
        let month;
        let year;

        if (match.length === 4 && monthMap[match[2]]) {
            day = match[1].padStart(2, '0');
            month = monthMap[match[2]];
            year = match[3];
        } else if (match.length === 4) {
            year = match[1];
            month = match[2];
            day = match[3];
        } else if (match.length === 3 && monthMap[match[1]]) {
            month = monthMap[match[1]];
            year = match[2];
        } else {
            continue;
        }

        const testDate = new Date(`${year}-${month}-${day}T00:00:00`);
        if (!isNaN(testDate.getTime())) {
            return `${day}/${month}/${year}`;
        }
    }

    return null;
}




// Função auxiliar para converter nome do mês para número
function getMonthNumber(month) {
    const months = {
        janeiro: '01',
        fevereiro: '02',
        março: '03',
        abril: '04',
        maio: '05',
        junho: '06',
        julho: '07',
        agosto: '08',
        setembro: '09',
        outubro: '10',
        novembro: '11',
        dezembro: '12'
    };

    return months[month?.toLowerCase()] || null;
}


// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

function normalizeDateBR(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;

    // yyyy-mm-dd
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
        const d = new Date(dateStr + 'T00:00:00-03:00');
        return isNaN(d) ? null : d;
    }

    // dd/mm/yyyy
    const match = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (match) {
        const [, day, month, year] = match;
        const d = new Date(`${year}-${month}-${day}T00:00:00-03:00`);
        return isNaN(d) ? null : d;
    }

    return null;
}



// Cache simples em memória
const cache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutos

// Inicializar browser ao iniciar servidor
initBrowser();

// Endpoint para buscar editais
app.post('/api/search', async (req, res) => {
    const { sources, searchTerm, filters } = req.body;
    let results = [];

    console.log('📩 Requisição recebida');
    console.log('🔎 Termo de busca:', searchTerm);
    console.log('🎛️ Filtros recebidos:', filters);

    if (!isBrowserReady) {
        console.log('⚠️ Browser não está pronto, tentando reinicializar...');
        await initBrowser();
    }

    // ----------------------------
    // BUSCA NAS FONTES
    // ----------------------------
    for (const source of sources) {
        try {
            console.log(`🔍 Buscando em: ${source.name} (${source.url})`);
            const sourceResults = await searchSourceWithPuppeteer(source, searchTerm);
            results.push(...sourceResults);
            console.log(`✅ ${sourceResults.length} resultados encontrados em ${source.name}`);
        } catch (error) {
            console.error(`❌ Erro ao buscar em ${source.name}:`, error.message);

            // Fallback com Axios
            try {
                const fallbackResults = await searchSourceWithAxios(source, searchTerm);
                results.push(...fallbackResults);
                console.log(`🔄 Fallback: ${fallbackResults.length} resultados com axios`);
            } catch (fallbackError) {
                console.error(`❌ Fallback também falhou para ${source.name}:`, fallbackError.message);
            }
        }
    }

    console.log(`📦 Total bruto de resultados: ${results.length}`);

    // ----------------------------
    // FILTRO DE DATAS (ROBUSTO)
    // ----------------------------
    let filteredResults = results;

    if (filters?.startDate || filters?.endDate) {
        const start = filters.startDate
            ? new Date(filters.startDate + 'T00:00:00')
            : null;

        const end = filters.endDate
            ? new Date(filters.endDate + 'T23:59:59')
            : null;

        console.log('📅 Período aplicado:', {
            start: start?.toISOString(),
            end: end?.toISOString()
        });

        filteredResults = filteredResults.filter(r => {
            const rawDate = r.date || r.data || null;
            const parsed = normalizeDateBR(rawDate);

            if (!parsed) {
                console.log('⛔ Resultado sem data válida:', r.title || r.link);
                return false;
            }

            if (start && parsed < start) return false;
            if (end && parsed > end) return false;

            return true;
        });
    }

    console.log(`🎯 Total após filtros: ${filteredResults.length}`);

    res.json({
        total: filteredResults.length,
        results: filteredResults
    });
});




// Função principal de busca com Puppeteer
async function searchSourceWithPuppeteer(source, searchTerm) {
    const cacheKey = `${source.url}-${searchTerm}`;

    // =========================
    // CACHE
    // =========================
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_DURATION) {
            console.log(`📋 Usando cache para ${source.name}`);
            return cached.data;
        }
    }

    const results = [];
    let page;

    try {
        // =========================
        // PÁGINA BASE
        // =========================
        page = await browser.newPage();

        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.setDefaultTimeout(30000);
        await page.setRequestInterception(true);

        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        console.log(`🌐 Navegando para: ${source.url}`);

        await page.goto(source.url, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        await page.waitForTimeout(2000);

        // =========================
        // CAPTURA HTML
        // =========================
        const pageHTML = await page.content();
        const pageTitle = await page.title();

        const $ = cheerio.load(pageHTML);

        // =========================
        // PARSE POR SITE
        // =========================
        let rawResults = [];

        if (source.url.includes('culturaemercado.com.br')) {
            rawResults = parseCulturaEmMercado($, source, searchTerm);
        } else if (source.url.includes('prosas.com.br')) {
            rawResults = parseProsas($, source, searchTerm);
        } else if (source.url.includes('gov.br')) {
            rawResults = parseGovBr($, source, searchTerm);
        } else if (source.url.includes('fcc.sc.gov.br')) {
            rawResults = parseFCC($, source, searchTerm);
        } else if (source.url.includes('cultura.sc.gov.br')) {
            rawResults = parseCulturaSC($, source, searchTerm);
        } else if (source.url.includes('amfri.org.br')) {
            rawResults = parseAMFRI($, source, searchTerm);
        } else if (source.url.includes('sesc-sc.com.br')) {
            rawResults = parseSescSC($, source, searchTerm);
        } else {
            rawResults = parseGeneric($, source, searchTerm);
        }

        console.log(`📦 Total bruto de resultados: ${rawResults.length}`);

        // =========================
        // DEDUPLICAÇÃO
        // =========================
        const seenUrls = new Set();
        const filteredRaw = rawResults.filter(r => {
            if (!r.url) return false;
            if (seenUrls.has(r.url)) return false;
            seenUrls.add(r.url);
            return true;
        });

        console.log(`🧹 Após remover duplicados: ${filteredRaw.length}`);

        // =========================
        // EXTRAÇÃO PROFISSIONAL DE DATAS
        // =========================
        for (const item of filteredRaw) {
            let extractedDate = null;
            let tempPage = null;

            try {
                // 1) Tentar direto no título e descrição
                extractedDate =
                    extractDateFromText(item.title || '') ||
                    extractDateFromText(item.description || '');

                // 2) Abrir página real para buscar HTML + texto
                if (!extractedDate && item.url) {
                    tempPage = await browser.newPage();
                    await tempPage.setDefaultTimeout(15000);

                    try {
                        await tempPage.goto(item.url, {
                            waitUntil: 'domcontentloaded',
                            timeout: 15000
                        });

                        await tempPage.waitForTimeout(1000);

                        const subPageHTML = await tempPage.content();
                        const subPageText = await tempPage.evaluate(() => {
                            return document.body?.innerText || '';
                        });

                        extractedDate = extractDateAdvanced(subPageHTML, subPageText);

                    } catch (err) {
                        console.log(`⚠️ Falha ao abrir página para data: ${item.url}`);
                    } finally {
                        if (tempPage) {
                            await tempPage.close();
                        }
                    }
                }

                // =========================
                // NORMALIZA RESULTADO
                // =========================
                const resultItem = {
                    titulo: item.title || 'Sem título',
                    link: item.url,
                    fonte: source.name,
                    tipo: item.type || 'web',
                    data: extractedDate || null,
                    trecho: item.description || '',
                    palavraChave: searchTerm,
                    relevancia: item.relevance || 0
                };

                results.push(resultItem);

                if (!extractedDate) {
                    console.log(`⛔ Sem data válida: ${item.url}`);
                } else {
                    console.log(`📅 Data encontrada: ${extractedDate} → ${item.url}`);
                }

            } catch (err) {
                console.log(`⚠️ Erro ao processar resultado: ${item.url || 'sem URL'}`);
                if (tempPage) {
                    await tempPage.close();
                }
            }
        }

        // =========================
        // CACHE
        // =========================
        cache.set(cacheKey, {
            data: results,
            timestamp: Date.now()
        });

    } catch (error) {
        console.error(`❌ Erro no Puppeteer para ${source.name}:`, error.message);
        throw error;
    } finally {
        if (page) {
            await page.close();
        }
    }

    return results;
}


function extractDateAdvanced(html, text = '') {
    const dates = [];

    const cheerio = require('cheerio');
    const $ = cheerio.load(html);

    // =========================
    // 1. TAGS <time datetime="">
    // =========================
    $('time[datetime]').each((_, el) => {
        const dt = $(el).attr('datetime');
        if (dt) dates.push(dt);
    });

    // =========================
    // 2. META TAGS PADRÃO
    // =========================
    const metaSelectors = [
        'meta[property="article:published_time"]',
        'meta[name="DC.date"]',
        'meta[name="date"]',
        'meta[name="dcterms.created"]',
        'meta[itemprop="datePublished"]'
    ];

    metaSelectors.forEach(sel => {
        const val = $(sel).attr('content');
        if (val) dates.push(val);
    });

    // =========================
    // 3. TEXTO VISÍVEL (REGEX)
    // =========================
    const regexes = [
        /\b(\d{2}\/\d{2}\/\d{4})\b/g,
        /\b(\d{4}-\d{2}-\d{2})\b/g,
        /\b(\d{2}\s+de\s+[a-zçãéíóú]+\s+de\s+\d{4})\b/gi
    ];

    regexes.forEach(rx => {
        let match;
        while ((match = rx.exec(text)) !== null) {
            dates.push(match[1]);
        }
    });

    // =========================
    // NORMALIZAÇÃO
    // =========================
    for (const d of dates) {
        const parsed = new Date(d);
        if (!isNaN(parsed.getTime())) {
            return parsed.toISOString().split('T')[0];
        }
    }

    return null;
}


function parseFunarteEditais($, source) {
    const results = [];

    $('.tileItem, .card, article').each((_, el) => {
        const title =
            $(el).find('h2, h3, .tileHeadline, .card-title').text().trim();

        const url =
            $(el).find('a').first().attr('href');

        const dateText =
            $(el).find('.date, time, .tileInfo, .card-date').text().trim();

        const date = extractDateFromText(dateText);

        if (title && url) {
            results.push({
                title,
                url: url.startsWith('http') ? url : `https://www.gov.br${url}`,
                description: '',
                data: date
            });
        }
    });

    return results;
}




// Função de fallback com axios
async function searchSourceWithAxios(source, searchTerm) {
    const cacheKey = `${source.url}-${searchTerm}-axios`;

    // =========================
    // CACHE
    // =========================
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_DURATION) {
            console.log(`📋 Usando cache (axios) para ${source.name}`);
            return cached.data;
        }
    }

    console.log(`🔄 Tentando fallback com axios para ${source.name}`);

    const results = [];

    try {
        // =========================
        // REQUISIÇÃO
        // =========================
        const response = await axios.get(source.url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept':
                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            },
            timeout: 15000,
            maxRedirects: 5
        });

        const $ = cheerio.load(response.data);

        // =========================
        // PARSE POR SITE
        // =========================
        let rawResults = [];

        if (source.url.includes('culturaemercado.com.br')) {
            rawResults = parseCulturaEmMercado($, source, searchTerm);
        } else if (source.url.includes('prosas.com.br')) {
            rawResults = parseProsas($, source, searchTerm);
        } else if (source.url.includes('funarte')) {
            rawResults = parseFunarteEditais($, source);
        } else if (source.url.includes('gov.br')) {
            rawResults = parseGovBr($, source, searchTerm);
        } else if (source.url.includes('fcc.sc.gov.br')) {
            rawResults = parseFCC($, source, searchTerm);
        } else if (source.url.includes('cultura.sc.gov.br')) {
            rawResults = parseCulturaSC($, source, searchTerm);
        } else if (source.url.includes('amfri.org.br')) {
            rawResults = parseAMFRI($, source, searchTerm);
        } else if (source.url.includes('sesc-sc.com.br')) {
            rawResults = parseSescSC($, source, searchTerm);
        } else {
            rawResults = parseGeneric($, source, searchTerm);
        }

        console.log(`📦 Total bruto de resultados (axios): ${rawResults.length}`);

        // =========================
        // EXTRAÇÃO REAL DE DATAS
        // =========================
        for (const item of rawResults) {
            try {
                let extractedDate = null;

                // 1) Título e descrição
                extractedDate =
                    extractDateFromText(item.title || '') ||
                    extractDateFromText(item.description || '');

                // 2) Página individual
                if (!extractedDate && item.url) {
                    try {
                        const pageResponse = await axios.get(item.url, {
                            headers: {
                                'User-Agent':
                                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                                    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                            },
                            timeout: 10000
                        });

                        const pageText = cheerio
                            .load(pageResponse.data)('body')
                            .text();

                        extractedDate = extractDateFromText(pageText);
                    } catch {
                        console.log(`⚠️ Axios não conseguiu abrir: ${item.url}`);
                    }
                }

                results.push({
                    title: item.title || 'Sem título',
                    url: item.url,
                    source: source.name,
                    data: extractedDate,
                    description: item.description || ''
                });

                if (!extractedDate) {
                    console.log(`⛔ Resultado sem data válida: ${item.url}`);
                } else {
                    console.log(`📅 Data encontrada: ${extractedDate} → ${item.url}`);
                }

            } catch {
                console.log('⚠️ Erro ao processar resultado individual (axios)');
            }
        }

        // =========================
        // CACHE
        // =========================
        cache.set(cacheKey, {
            data: results,
            timestamp: Date.now()
        });

        return results;

    } catch (error) {
        console.error(`❌ Fallback axios falhou para ${source.name}:`, error.message);
        return [];
    }
}


// Parser para Cultura em Mercado
function parseCulturaEmMercado($, source, searchTerm) {
    const results = [];
    const keywords = ['escultura', 'arte', 'visual', 'cultura', 'edital', 'exposição'];
    
    $('.post-item, .edital-item, article').each((index, element) => {
        const $el = $(element);
        const title = $el.find('h2, h3, .title').text().trim();
        const link = $el.find('a').attr('href');
        const excerpt = $el.find('.excerpt, .content, p').text().trim();
        const date = $el.find('.date, time').text().trim();
        
        const fullText = `${title} ${excerpt}`.toLowerCase();
        const hasKeyword = keywords.some(k => fullText.includes(k));
        const matchesSearch = searchTerm.split(' ').some(term => 
            fullText.includes(term.toLowerCase())
        );
        
        // BUSCA LIVRE: aceitar qualquer texto que contenha o termo de busca
        if (matchesSearch && link) {
            results.push({
                titulo: title || 'Edital sem título',
                link: link.startsWith('http') ? link : `${source.url}${link}`,
                fonte: new URL(source.url).hostname,
                trecho: excerpt.substring(0, 300) + '...',
                data: parseDate(date),
                tipo: 'web',
                palavraChave: keywords.find(k => fullText.includes(k)) || searchTerm
            });
        }
    });
    
    return results;
}

// Parser para Prosas
function parseProsas($, source, searchTerm) {
    const results = [];
    
    // Buscar editais na API do Prosas
    const apiUrl = 'https://prosas.com.br/api/v1/editais';
    
    $('.opportunity-card, .edital-card').each((index, element) => {
        const $el = $(element);
        const title = $el.find('.title, h3').text().trim();
        const link = $el.find('a').attr('href');
        const deadline = $el.find('.deadline').text().trim();
        const description = $el.find('.description').text().trim();
        
        if (title.toLowerCase().includes(searchTerm.toLowerCase())) {
            results.push({
                titulo: title,
                link: `https://prosas.com.br${link}`,
                fonte: 'prosas.com.br',
                trecho: description.substring(0, 300) + '...',
                data: deadline,
                tipo: 'web',
                palavraChave: 'edital'
            });
        }
    });
    
    return results;
}

// Parser para sites Gov.br - SUPER abrangente
function parseGovBr($, source, searchTerm) {
    const results = [];
    const seen = new Set();

    const KEYWORDS = [
        'edital',
        'chamada pública',
        'chamada publica',
        'inscrições',
        'inscricoes',
        'seleção',
        'selecao',
        'prêmio',
        'premio',
        'fomento',
        'concurso',
        'abertas',
        'aberto'
    ];

    $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        let text = $(el).text();

        if (!href || !text) return;

        text = text.replace(/\s+/g, ' ').trim();
        if (text.length < 8) return;

        const fullUrl = href.startsWith('http')
            ? href
            : new URL(href, source.url).href;

        const lowerText = text.toLowerCase();

        const isRelevant = KEYWORDS.some(k => lowerText.includes(k));
        if (!isRelevant) return;

        if (seen.has(fullUrl)) return;
        seen.add(fullUrl);

        results.push({
            title: text,
            url: fullUrl,
            description: text,
            source: source.name
        });
    });

    return results;
}


// Parser para FCC SC - Busca mais abrangente
function parseFCC($, source, searchTerm) {
    const results = [];
    const searchLower = searchTerm.toLowerCase();
    
    // Buscar em TODOS os links que contenham o termo de busca
    $('a').each((index, element) => {
        const $el = $(element);
        const text = $el.text().trim();
        const href = $el.attr('href');
        
        if (text && href && text.length > 3 && text.length < 200) {
            const textLower = text.toLowerCase();
            
            // Verificar se contém termo de busca OU palavras-chave culturais
            const matchesSearch = textLower.includes(searchLower);
            const hasCulturalKeyword = ['cultura', 'arte', 'edital', 'seleção', 'chamada', 'prêmio', 'bolsa', 'fomento', 'incentivo', 'patrocínio', 'licitação', 'pregão', 'concorrência', 'credenciamento', 'oportunidade', 'programa', 'projeto', 'certame', 'residência', 'circuito', 'festival', 'mostra', 'exposição', 'bienal', 'instalação', 'escultura', 'visual', 'contemporânea', 'contemporanea'].some(k => textLower.includes(k));
            
            if (matchesSearch || hasCulturalKeyword) {
                const fullUrl = href.startsWith('http') ? href : 
                               href.startsWith('/') ? `${new URL(source.url).origin}${href}` : 
                               `${source.url}/${href}`;
                
                // Tentar extrair data real do texto
                const extractedDate = extractDateFromText(text);
                
                results.push({
                    titulo: text,
                    link: fullUrl,
                    fonte: new URL(source.url).hostname,
                    trecho: `Link encontrado: ${text}`,
                    data: extractedDate || 'Data não encontrada',
                    tipo: href.endsWith('.pdf') ? 'pdf' : 'web',
                    palavraChave: hasCulturalKeyword ? 'cultural' : searchTerm
                });
            }
        }
    });
    
    // Buscar em textos e parágrafos
    $('p, li, article, section, div, span').each((index, element) => {
        const $el = $(element);
        const text = $el.text().trim();
        
        if (text.length > 20 && text.length < 1000) {
            const textLower = text.toLowerCase();
            const matchesSearch = textLower.includes(searchLower);
            const hasCulturalKeyword = ['cultura', 'arte', 'edital', 'seleção', 'chamada', 'prêmio', 'bolsa', 'fomento', 'incentivo', 'patrocínio', 'licitação', 'pregão', 'concorrência', 'credenciamento', 'oportunidade', 'programa', 'projeto', 'certame', 'residência', 'circuito', 'festival', 'mostra', 'exposição', 'bienal', 'instalação', 'escultura', 'visual', 'contemporânea', 'contemporanea'].some(k => textLower.includes(k));
            
            if (matchesSearch || hasCulturalKeyword) {
                // Tentar encontrar link próximo
                const nearbyLink = $el.find('a').first() || $el.closest('a');
                const link = nearbyLink.length > 0 ? nearbyLink.attr('href') : source.url;
                
                // Tentar extrair data real do texto
                const extractedDate = extractDateFromText(text);
                
                results.push({
                    titulo: text.substring(0, 120) + '...',
                    link: link.startsWith('http') ? link : `${source.url}${link}`,
                    fonte: new URL(source.url).hostname,
                    trecho: text.substring(0, 300) + '...',
                    data: extractedDate || 'Data não encontrada',
                    tipo: 'web',
                    palavraChave: hasCulturalKeyword ? 'cultural' : searchTerm
                });
            }
        }
    });
    
    // Buscar em títulos e cabeçalhos
    $('h1, h2, h3, h4, h5, h6, .titulo, .title, .headline').each((index, element) => {
        const $el = $(element);
        const text = $el.text().trim();
        
        if (text.length > 5 && text.length < 200) {
            const textLower = text.toLowerCase();
            const matchesSearch = textLower.includes(searchLower);
            const hasCulturalKeyword = ['cultura', 'arte', 'edital', 'seleção', 'chamada', 'prêmio', 'bolsa', 'fomento', 'incentivo', 'patrocínio', 'licitação', 'pregão', 'concorrência', 'credenciamento', 'oportunidade', 'programa', 'projeto', 'certame', 'residência', 'circuito', 'festival', 'mostra', 'exposição', 'bienal', 'instalação', 'escultura', 'visual', 'contemporânea', 'contemporanea'].some(k => textLower.includes(k));
            
            if (matchesSearch || hasCulturalKeyword) {
                // Tentar encontrar link próximo
                const nearbyLink = $el.find('a').first() || $el.closest('a');
                const link = nearbyLink.length > 0 ? nearbyLink.attr('href') : source.url;
                
                // Tentar extrair data real do texto
                const extractedDate = extractDateFromText(text);
                
                results.push({
                    titulo: text,
                    link: link.startsWith('http') ? link : `${source.url}${link}`,
                    fonte: new URL(source.url).hostname,
                    trecho: `Título encontrado: ${text}`,
                    data: extractedDate || 'Data não encontrada',
                    tipo: 'web',
                    palavraChave: hasCulturalKeyword ? 'cultural' : searchTerm
                });
            }
        }
    });
    
    return results.slice(0, 25); // Aumentar limite
}

// Parser para Cultura SC
function parseCulturaSC($, source, searchTerm) {
    const results = [];
    
    // Buscar em editais e oportunidades
    $('.edital, .oportunidade, .chamada, [class*="edital"]').each((index, element) => {
        const $el = $(element);
        const title = $el.find('h2, h3, .titulo').text().trim();
        const link = $el.find('a').attr('href');
        const content = $el.text().trim();
        
        if (title && link) {
            // Tentar extrair data real do conteúdo
            const extractedDate = extractDateFromText(content);
            
            results.push({
                titulo: title,
                link: link.startsWith('http') ? link : `${source.url}${link}`,
                fonte: new URL(source.url).hostname,
                trecho: content.substring(0, 300) + '...',
                data: extractedDate || 'Data não encontrada',
                tipo: 'web',
                palavraChave: 'edital'
            });
        }
    });
    
    return results.slice(0, 15);
}

// Parser para AMFRI
function parseAMFRI($, source, searchTerm) {
    const results = [];
    
    // Buscar em páginas de cultura
    $('.pagina-47428, [class*="cultura"], [class*="edital"]').each((index, element) => {
        const $el = $(element);
        const title = $el.find('h1, h2, h3, .titulo').text().trim();
        const content = $el.text().trim();
        
        if (title && content.length > 50) {
            // Tentar extrair data real do conteúdo
            const extractedDate = extractDateFromText(content);
            
            results.push({
                titulo: title,
                link: source.url,
                fonte: new URL(source.url).hostname,
                trecho: content.substring(0, 300) + '...',
                data: extractedDate || 'Data não encontrada',
                tipo: 'web',
                palavraChave: 'cultura'
            });
        }
    });
    
    return results.slice(0, 10);
}

// Parser específico para SESC SC - SUPER PRECISO
function parseSescSC($, source, searchTerm) {
    const results = [];
    const searchLower = searchTerm.toLowerCase();
    
    console.log(`🔍 Parsing SESC SC para termo: "${searchTerm}"`);
    
    // Buscar especificamente em licitações
    $('.licitacao-item, [class*="licitacao"], .edital-item, [class*="edital"]').each((index, element) => {
        const $el = $(element);
        const title = $el.find('h3, h4, .titulo, strong').text().trim();
        const content = $el.text().trim();
        
        if (title && content.length > 20) {
            // Verificar se realmente contém o termo de busca
            const contentLower = content.toLowerCase();
            const hasSearchTerm = searchLower.split(' ').some(term => 
                term.length > 2 && contentLower.includes(term.toLowerCase())
            );
            
            if (hasSearchTerm) {
                // Extrair data específica do SESC
                let extractedDate = null;
                
                // Padrões específicos do SESC
                const datePatterns = [
                    /Data abertura:\s*(\d{2}\/\d{2}\/\d{4})/i,
                    /Data atualização:\s*(\d{2}\/\d{2}\/\d{4})/i,
                    /adicionado em\s*(\d{2}\/\d{2}\/\d{4})/i,
                    /(\d{2}\/\d{2}\/\d{4})\s*às\s*\d{2}:\d{2}/i
                ];
                
                for (const pattern of datePatterns) {
                    const match = content.match(pattern);
                    if (match) {
                        extractedDate = match[1];
                        console.log(`📅 Data SESC encontrada: ${extractedDate}`);
                        break;
                    }
                }
                
                // Se não encontrou data específica, tentar extrair do texto
                if (!extractedDate) {
                    extractedDate = extractDateFromText(content);
                }
                
                console.log(`✅ Licitação SESC encontrada: "${title.substring(0, 50)}..." | Data: ${extractedDate || 'não encontrada'}`);
                
                results.push({
                    titulo: title,
                    link: source.url,
                    fonte: new URL(source.url).hostname,
                    trecho: content.substring(0, 400) + '...',
                    data: extractedDate || 'Data não encontrada',
                    tipo: 'web',
                    palavraChave: 'licitação'
                });
            }
        }
    });
    
    // Se não encontrou licitações específicas, buscar em todo o conteúdo
    if (results.length === 0) {
        console.log(`⚠️ Nenhuma licitação específica encontrada, buscando em todo o conteúdo`);
        
        $('p, div, span').each((index, element) => {
            const $el = $(element);
            const text = $el.text().trim();
            
            if (text.length > 30 && text.length < 800) {
                const textLower = text.toLowerCase();
                const hasSearchTerm = searchLower.split(' ').some(term => 
                    term.length > 2 && textLower.includes(term.toLowerCase())
                );
                
                if (hasSearchTerm) {
                    // Extrair data
                    const extractedDate = extractDateFromText(text);
                    
                    results.push({
                        titulo: text.substring(0, 100) + '...',
                        link: source.url,
                        fonte: new URL(source.url).hostname,
                        trecho: text.substring(0, 300) + '...',
                        data: extractedDate || 'Data não encontrada',
                        tipo: 'web',
                        palavraChave: 'conteúdo'
                    });
                }
            }
        });
    }
    
    console.log(`📊 Total de resultados SESC SC: ${results.length}`);
    return results.slice(0, 25);
}

// Busca alternativa quando scraping falha
async function searchAlternative(source, searchTerm) {
    const results = [];
    
    // Criar resultado genérico para navegação
    results.push({
        titulo: `Navegar em ${source.name}`,
        link: source.url,
        fonte: new URL(source.url).hostname,
        trecho: `Acesse o site para buscar editais relacionados a "${searchTerm}"`,
        data: 'Data não encontrada',
        tipo: 'web',
        palavraChave: 'navegação'
    });
    
    return results;
}

// Parser genérico SUPER abrangente
function parseGeneric($, source, searchTerm) {
    const results = [];
    const searchLower = searchTerm.toLowerCase();
    
    // Lista expandida de palavras-chave culturais
    const culturalKeywords = [
        'edital', 'cultura', 'arte', 'seleção', 'inscrição', 'chamada', 'prêmio', 'bolsa', 'fomento', 
        'incentivo', 'patrocínio', 'licitação', 'pregão', 'concorrência', 'credenciamento', 'oportunidade', 
        'programa', 'projeto', 'certame', 'residência', 'circuito', 'festival', 'mostra', 'exposição', 
        'bienal', 'instalação', 'escultura', 'visual', 'contemporânea', 'contemporanea', 'artístico', 
        'artistico', 'cultural', 'museu', 'galeria', 'curadoria', 'artista', 'criativo', 'inovação', 
        'inovacao', 'tecnologia', 'digital', 'multimídia', 'multimidia', 'performance', 'interativo', 
        'interativo', 'experimental', 'tradicional', 'popular', 'erudito', 'clássico', 'classico', 
        'moderno', 'pós-moderno', 'pos-moderno', 'vanguarda', 'emergente', 'estabelecido', 'herança', 
        'heranca', 'patrimônio', 'patrimonio', 'histórico', 'historico', 'sociedade', 'comunidade', 
        'educação', 'educacao', 'formação', 'formacao', 'capacitação', 'capacitacao', 'workshop', 
        'oficina', 'palestra', 'debate', 'seminário', 'seminario', 'congresso', 'encontro', 'colóquio', 
        'coloquio', 'simpósio', 'simposio', 'conferência', 'conferencia', 'apresentação', 'apresentacao'
    ];
    
    // Buscar em TODOS os links (mais abrangente)
    $('a').each((index, element) => {
        const $el = $(element);
        const text = $el.text().trim();
        const href = $el.attr('href');
        
        if (text && href && text.length > 2 && text.length < 300) {
            const textLower = text.toLowerCase();
            
            // BUSCA LIVRE: aceitar qualquer texto que contenha o termo de busca
            const matchesSearch = textLower.includes(searchLower);
            const hasCulturalKeyword = culturalKeywords.some(k => textLower.includes(k));
            
            if (matchesSearch) {
                const fullUrl = href.startsWith('http') ? href : 
                               href.startsWith('/') ? `${new URL(source.url).origin}${href}` : 
                               `${source.url}/${href}`;
                
                // Tentar extrair data real do texto
                const extractedDate = extractDateFromText(text);
                
                results.push({
                    titulo: text,
                    link: fullUrl,
                    fonte: new URL(source.url).hostname,
                    trecho: `Link encontrado: ${text}`,
                    data: extractedDate || 'Data não encontrada',
                    tipo: href.endsWith('.pdf') ? 'pdf' : 'web',
                    palavraChave: hasCulturalKeyword ? 'cultural' : searchTerm
                });
            }
        }
    });
    
    // Buscar em TODOS os textos (mais abrangente)
    $('p, li, article, section, div, span, h1, h2, h3, h4, h5, h6, .titulo, .title, .headline, .content, .text').each((index, element) => {
        const $el = $(element);
        const text = $el.text().trim();
        
        if (text.length > 15 && text.length < 800) {
            const textLower = text.toLowerCase();
            const matchesSearch = textLower.includes(searchLower);
            const hasCulturalKeyword = culturalKeywords.some(k => textLower.includes(k));
            
            if (matchesSearch || hasCulturalKeyword) {
                // Tentar encontrar link próximo
                const nearbyLink = $el.find('a').first() || $el.closest('a');
                const link = nearbyLink.length > 0 ? nearbyLink.attr('href') : source.url;
                
                // Tentar extrair data real do texto
                const extractedDate = extractDateFromText(text);
                
                results.push({
                    titulo: text.substring(0, 150) + '...',
                    link: link.startsWith('http') ? link : `${source.url}${link}`,
                    fonte: new URL(source.url).hostname,
                    trecho: text.substring(0, 400) + '...',
                    data: extractedDate || 'Data não encontrada',
                    tipo: 'web',
                    palavraChave: hasCulturalKeyword ? 'cultural' : searchTerm
                });
            }
        }
    });
    
    // Buscar em atributos alt e title das imagens
    $('img').each((index, element) => {
        const $el = $(element);
        const alt = $el.attr('alt') || '';
        const title = $el.attr('title') || '';
        const text = alt || title;
        
        if (text && text.length > 5) {
            const textLower = text.toLowerCase();
            const matchesSearch = textLower.includes(searchLower);
            const hasCulturalKeyword = culturalKeywords.some(k => textLower.includes(k));
            
            if (matchesSearch || hasCulturalKeyword) {
                // Tentar encontrar link próximo
                const nearbyLink = $el.closest('a');
                const link = nearbyLink.length > 0 ? nearbyLink.attr('href') : source.url;
                
                // Tentar extrair data real do contexto da imagem
                const parentText = $el.parent().text();
                const extractedDate = extractDateFromText(text) || extractDateFromText(parentText);
                
                results.push({
                    titulo: `Imagem: ${text}`,
                    link: link.startsWith('http') ? link : `${source.url}${link}`,
                    fonte: new URL(source.url).hostname,
                    trecho: `Descrição da imagem: ${text}`,
                    data: extractedDate || 'Data não encontrada',
                    tipo: 'web',
                    palavraChave: hasCulturalKeyword ? 'cultural' : searchTerm
                });
            }
        }
    });
    
    return results.slice(0, 30); // Aumentar muito o limite
}

// Função auxiliar para parse de datas
function parseDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;

    const text = dateStr.trim().toLowerCase();

    // =========================
    // ISO → 2024-11-03
    // =========================
    let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
        return new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00`);
    }

    // =========================
    // BR → 03/11/2024
    // =========================
    match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) {
        return new Date(`${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}T12:00:00`);
    }

    // =========================
    // "3 de novembro de 2024"
    // =========================
    const meses = {
        janeiro: 0, fevereiro: 1, março: 2, marco: 2,
        abril: 3, maio: 4, junho: 5,
        julho: 6, agosto: 7, setembro: 8,
        outubro: 9, novembro: 10, dezembro: 11
    };

    match = text.match(/(\d{1,2})?\s*(de)?\s*(janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*(de)?\s*(\d{4})/);
    if (match) {
        const dia = match[1] ? parseInt(match[1]) : 1;
        const mes = meses[match[3]];
        const ano = parseInt(match[5]);

        return new Date(ano, mes, dia, 12, 0, 0);
    }

    // =========================
    // "2024"
    // =========================
    match = text.match(/^(\d{4})$/);
    if (match) {
        return new Date(parseInt(match[1]), 0, 1, 12, 0, 0);
    }

    return null;
}


// Endpoint para buscar em APIs específicas
app.get('/api/search-apis', async (req, res) => {
    const { term } = req.query;
    const results = [];
    
    // API do Portal da Transparência (exemplo)
    try {
        // Aqui você pode adicionar chamadas para APIs reais
        // Por exemplo: API do DOU, API de portais de transparência, etc.
    } catch (error) {
        console.error('Erro ao buscar em APIs:', error);
    }
    
    res.json({ results });
});

// Servir a aplicação
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
    console.log('Acesse a aplicação e faça buscas reais por editais!');
});
