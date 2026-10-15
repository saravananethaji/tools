import React from 'react';
import ReactDOM from 'react-dom/client';
import FeatureFileExplorer from './components/FeatureFileExplorer';
import './components/FeatureFileExplorer.css';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <div className="App">
      <header className="App-header">
        <h1>Feature File Explorer Tool</h1>
        <p>A tool to analyze Gherkin/Cucumber .feature files and explain their execution flow</p>
      </header>
      <main>
        <FeatureFileExplorer />
      </main>
    </div>
  </React.StrictMode>
);