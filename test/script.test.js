// script.test.js
import 'fake-indexeddb/auto'; // Dit mockt IndexedDB automatisch in het geheugen

// We importeren de functies uit jouw script.
// LET OP: Voeg onderaan je script.js: module.exports = { saveSnippetToDB, updateKnowledgeGraph, getSuggestions, getDB, deleteSnippetFromDB }; toe
const { 
    saveSnippetToDB, 
    updateKnowledgeGraph, 
    getSuggestions, 
    getDB,
    deleteSnippetFromDB
} = require('../script'); 

describe('SnippetManager - Kookboek Editie', () => {

    // Helper om DB schoon te maken voor elke test
    beforeEach(async () => {
        // Omdat fake-indexeddb in memory blijft, verwijderen we de DB handmatig of gebruiken we unieke keys
        // Voor integratietests is het vaak makkelijker om de stores te clearen
        const db = await getDB();
        const tx = db.transaction(['snippets', 'tags', 'tag_stats', 'domain_stats'], 'readwrite');
        tx.objectStore('snippets').clear();
        tx.objectStore('tags').clear();
        tx.objectStore('tag_stats').clear();
        tx.objectStore('domain_stats').clear();
        
        // Wacht tot transactie klaar is
        await new Promise(resolve => {
            tx.oncomplete = resolve;
        });
    });

    describe('Feature: Opslaan van Recept Snippets', () => {
        test('Scenario: Een nieuw pasta recept opslaan met tags', async () => {
            // GIVEN
            const snippetText = "Recept voor Pasta Carbonara: eieren, pecorino, guanciale #recept #pasta #italiaans";
            const tags = ['recept', 'pasta', 'italiaans'];
            const timestamp = Date.now();

            const item = {
                text: snippetText,
                timestamp: timestamp,
                tags: tags,
                meta: null
            };

            // WHEN
            const result = await saveSnippetToDB(item);

            // THEN
            // 1. Check of return object klopt
            expect(result.id).toBeDefined();
            expect(result.text).toBe(snippetText);

            // 2. Check of het daadwerkelijk in de DB staat
            const db = await getDB();
            const tx = db.transaction('snippets', 'readonly');
            const savedItem = await new Promise(resolve => {
                const req = tx.objectStore('snippets').get(result.id);
                req.onsuccess = () => resolve(req.result);
            });

            expect(savedItem).toEqual({
                id: result.id,
                text: snippetText,
                timestamp: timestamp,
                tags: tags,
                meta: null
            });
        });
    });

    describe('Feature: Knowledge Graph (Het Brein)', () => {
        
        test('Scenario: Co-occurrence statistieken bijwerken (Connecties leggen)', async () => {
            // GIVEN
            // De gebruiker voegt een recept toe met tags die bij elkaar horen
            const tags = ['pasta', 'tomaat']; 
            const domain = 'smulweb.nl';

            // WHEN
            await updateKnowledgeGraph(tags, domain);

            // THEN
            const db = await getDB();
            
            // Check Tag Stats (moet alfabetisch gesorteerd zijn: pasta_tomaat)
            const tx = db.transaction('tag_stats', 'readonly');
            const stat = await new Promise(resolve => {
                const req = tx.objectStore('tag_stats').get('pasta_tomaat');
                req.onsuccess = () => resolve(req.result);
            });

            expect(stat).toBeDefined();
            expect(stat.count).toBe(1); // Eerste keer dat ze samen voorkomen
            expect(stat.pair).toBe('pasta_tomaat');
        });

        test('Scenario: Domein statistieken bijwerken', async () => {
            // GIVEN
            const tags = ['dessert', 'chocolade'];
            const domain = '24kitchen.nl';

            // WHEN
            await updateKnowledgeGraph(tags, domain);

            // THEN
            const db = await getDB();
            const tx = db.transaction('domain_stats', 'readonly');
            const domainData = await new Promise(resolve => {
                const req = tx.objectStore('domain_stats').get('24kitchen.nl');
                req.onsuccess = () => resolve(req.result);
            });

            expect(domainData).toBeDefined();
            expect(domainData.tagCounts['dessert']).toBe(1);
            expect(domainData.tagCounts['chocolade']).toBe(1);
        });
    });

    describe('Feature: Suggestie Systeem (Predictive Tags)', () => {

        test('Scenario: Suggesties op basis van associatie (De Pasta Test)', async () => {
            // GIVEN
            // We trainen het brein: Pasta wordt vaak gegeten met Tomaat en Basilicum
            // Pasta + Tomaat (komt 3 keer voor)
            await updateKnowledgeGraph(['pasta', 'tomaat']);
            await updateKnowledgeGraph(['pasta', 'tomaat']);
            await updateKnowledgeGraph(['pasta', 'tomaat']);
            
            // Pasta + Basilicum (komt 1 keer voor)
            await updateKnowledgeGraph(['pasta', 'basilicum']);

            // Pasta + Auto (komt nooit voor in deze context, maar als ruis)
            await updateKnowledgeGraph(['fiets', 'auto']);

            // WHEN
            // De gebruiker typt nu: "#pasta"
            const currentInputTags = ['pasta'];
            const domain = null;
            const suggestions = await getSuggestions(currentInputTags, domain);

            // THEN
            // We verwachten dat 'tomaat' de sterkste suggestie is, gevolgd door 'basilicum'
            // 'pasta' zelf mag NIET in de suggesties staan (die hebben we al)
            
            expect(suggestions).toContain('tomaat');
            expect(suggestions).toContain('basilicum');
            expect(suggestions).not.toContain('pasta'); // Reeds getypt
            expect(suggestions).not.toContain('auto');  // Geen relatie

            // Check volgorde (tomaat is populairder)
            expect(suggestions[0]).toBe('tomaat');
            expect(suggestions[1]).toBe('basilicum');
        });

        test('Scenario: Suggesties op basis van domein', async () => {
            // GIVEN
            // Op ah.nl zoeken we vaak naar #boodschappen en #bonus
            await updateKnowledgeGraph(['boodschappen', 'bonus', 'recept'], 'ah.nl');
            await updateKnowledgeGraph(['boodschappen', 'bonus'], 'ah.nl');
            // Bonus komt nu 2x voor op ah.nl

            // WHEN
            // We zijn op ah.nl maar hebben nog geen tags getypt
            const currentInputTags = [];
            const domain = 'ah.nl';
            const suggestions = await getSuggestions(currentInputTags, domain);

            // THEN
            // 'bonus' en 'boodschappen' moeten bovenaan staan vanwege domein populariteit
            expect(suggestions).toContain('bonus');
            expect(suggestions).toContain('boodschappen');
        });
    });

    describe('Edge Cases', () => {
        test('Edge Case: Input met slechts 1 tag (geen paar te vormen)', async () => {
            // GIVEN
            const tags = ['eenzaam'];

            // WHEN
            await updateKnowledgeGraph(tags, null);

            // THEN
            // Er zijn minstens 2 tags nodig voor een co-occurrence paar
            const db = await getDB();
            const tx = db.transaction('tag_stats', 'readonly');
            const stats = await new Promise(resolve => {
                const req = tx.objectStore('tag_stats').getAll();
                req.onsuccess = () => resolve(req.result);
            });

            expect(stats.length).toBe(0); // Geen paren gemaakt
        });

        test('Edge Case: Input zonder tags', async () => {
            // GIVEN
            const tags = [];
            
            // WHEN
            // Zou niet moeten crashen
            await updateKnowledgeGraph(tags, 'example.com');

            // THEN
            // Validatie dat er niets gebeurd is, of dat de functie 'clean' returned
            expect(true).toBe(true); 
        });
        
        test('Edge Case: Suggesties filteren reeds getypte tags correct', async () => {
             // GIVEN
             await updateKnowledgeGraph(['soep', 'balletjes']);
             
             // WHEN
             const currentTags = ['soep', 'balletjes']; // Alles is al getypt
             const suggestions = await getSuggestions(currentTags, null);
             
             // THEN
             expect(suggestions.length).toBe(0); // Geen suggesties meer over
        });
    });
});